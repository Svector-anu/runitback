import {
  deleteElements, duplicateCommand, moveElements, splitCommand, trimElementCommand, updateElements,
} from "#/engine/commands";
import { RETIME_MAX, RETIME_MIN, isRetimable, type ElementRef, type TimelineElement } from "#/engine/model";
import {
  allElements, elementEnd, elementsStrictlyAt, enforceMainTrackStart, intervalsOverlap, planChangesAnything,
  sourceSpanAtClipTime, timelineDurationForSourceSpan, trackTypeForElement, type LocatedElement, type PlannedMove,
} from "#/engine/timeline";
import { mediaTimeFromSeconds } from "#/engine/time";
import { defineTool, ok, toSec, ToolError, type ToolEnv } from "./env";
import type { AgentTool, JsonSchema } from "./types";

const ELEMENT_IDS: JsonSchema = {
  type: "array",
  items: { type: "string" },
  description: "Element ids from get_timeline.",
};

function describeSpan(located: LocatedElement): string {
  const e = located.element;
  return `${e.id} (${toSec(e.startTime)}s-${toSec(elementEnd(e))}s)`;
}

const split = defineTool<{ at?: number; elementIds?: string[]; retain?: "both" | "left" | "right" }>({
  name: "split",
  description:
    "Cut clips at a timeline time. `at` is SECONDS (default: the playhead; snapped to the frame grid). Without elementIds every clip crossing `at` is cut; with elementIds only those are (clips not crossing `at` are skipped and reported). `retain` keeps both halves (default), only the `left` half (drops everything after `at`) or only the `right` half (drops everything before `at`). The left half keeps the original id; the right half gets a new id (returned in data.pieces).",
  inputSchema: {
    type: "object",
    properties: {
      at: { type: "number", minimum: 0, description: "Cut time in SECONDS on the timeline." },
      elementIds: ELEMENT_IDS,
      retain: { type: "string", enum: ["both", "left", "right"] },
    },
  },
  readOnly: false,
  run(input, env) {
    env.requireProject();
    const time = input.at === undefined ? env.playhead : env.snap(input.at);
    const requested = input.elementIds ? env.requireMany(input.elementIds) : null;
    const crossing = elementsStrictlyAt(env.tracks, time);
    const targets = requested ? requested.filter((l) => l.element.startTime < time && elementEnd(l.element) > time) : crossing;
    if (targets.length === 0) {
      const spans = (requested ?? allElements(env.tracks)).map(describeSpan).join(", ") || "(timeline is empty)";
      throw new ToolError(`No clip crosses ${toSec(time)}s, so there is nothing to split.`, `A cut must fall strictly inside a clip. Clips: ${spans}.`);
    }
    const skipped = (requested ?? []).filter((l) => !targets.includes(l)).map((l) => l.element.id);
    const beforeIds = new Set(allElements(env.tracks).map((l) => l.element.id));
    env.editor.execute(splitCommand({ refs: targets.map((t) => t.ref), splitTime: time, retainSide: input.retain }));
    const after = allElements(env.tracks);
    const pieces = targets.map((target) => {
      const left = after.find((l) => l.element.id === target.element.id);
      const right = after.find((l) => l.track.id === target.track.id && !beforeIds.has(l.element.id) && l.element.startTime === time);
      return { originalId: target.element.id, left: left?.element.id, right: right?.element.id };
    });
    const retain = input.retain ?? "both";
    return ok(`Split ${targets.length} clip(s) at ${toSec(time)}s (retain: ${retain}).`, { at: toSec(time), retain, pieces, skipped });
  },
});

const trim = defineTool<{ elementId: string; start?: number; end?: number }>({
  name: "trim",
  description:
    "Move a clip's edges to absolute timeline times in SECONDS (snapped to frames). `start` = where the clip should now begin (cuts the head or restores source if available); `end` = where it should now end (cuts the tail or extends it). The clip is not shifted: trimming only changes which part of the source plays. Edges clamp to available source media and to neighbouring clips on the track; data.clamped says if that happened. The first clip on the main track always snaps to start at 0.",
  inputSchema: {
    type: "object",
    properties: {
      elementId: { type: "string" },
      start: { type: "number", minimum: 0, description: "New left edge, timeline SECONDS." },
      end: { type: "number", minimum: 0, description: "New right edge, timeline SECONDS." },
    },
    required: ["elementId"],
  },
  readOnly: false,
  run(input, env) {
    env.requireProject();
    if (input.start === undefined && input.end === undefined) {
      throw new ToolError("Nothing to trim.", "Pass `start` (new left edge) and/or `end` (new right edge) in seconds.");
    }
    const located = env.require(input.elementId);
    const element = located.element;
    const start = input.start === undefined ? undefined : env.snap(input.start);
    const end = input.end === undefined ? undefined : env.snap(input.end);
    const newStart = start ?? element.startTime;
    const newEnd = end ?? elementEnd(element);
    if (newEnd <= newStart) {
      throw new ToolError(
        `Trim would leave an empty clip (start ${toSec(newStart)}s, end ${toSec(newEnd)}s).`,
        `The clip currently spans ${toSec(element.startTime)}s-${toSec(elementEnd(element))}s; keep end greater than start. To remove it use delete.`,
      );
    }
    env.editor.execute(trimElementCommand({ ref: located.ref, start, end }));
    const after = env.require(input.elementId).element;
    const clamped = (start !== undefined && after.startTime !== start) || (end !== undefined && elementEnd(after) !== end);
    const data = {
      elementId: after.id, start: toSec(after.startTime), end: toSec(elementEnd(after)), duration: toSec(after.duration),
      trimStart: toSec(after.trimStart), clamped,
    };
    return ok(
      `Trimmed ${after.id} to ${data.start}s-${data.end}s${clamped ? " (clamped by source length, neighbours or the main-track start rule)" : ""}.`,
      data,
    );
  },
});

const move = defineTool<{ elementIds: string[]; delta?: number; start?: number; trackId?: string }>({
  name: "move",
  description:
    "Move clips in time and/or to another track. Use `delta` (SECONDS, may be negative) to shift all given clips, or `start` (SECONDS) to place the earliest given clip there with the others keeping their offsets. `trackId` sends all clips to that track (kinds must match). Times snap to frames. Fails (nothing changes) if a clip would overlap another or start before 0; on the main track a clip at/before the earliest other clip starts at 0.",
  inputSchema: {
    type: "object",
    properties: {
      elementIds: { ...ELEMENT_IDS, description: "Clips to move together." },
      delta: { type: "number", description: "Shift in SECONDS (positive = later)." },
      start: { type: "number", minimum: 0, description: "New start in SECONDS for the earliest clip of the group." },
      trackId: { type: "string", description: "Destination track id." },
    },
    required: ["elementIds"],
  },
  readOnly: false,
  run(input, env) {
    env.requireProject();
    if (input.elementIds.length === 0) throw new ToolError("elementIds is empty.", "Pass at least one element id.");
    if (input.delta !== undefined && input.start !== undefined) throw new ToolError("Pass either delta or start, not both.", "Use delta to shift, start to place absolutely.");
    if (input.delta === undefined && input.start === undefined && input.trackId === undefined) {
      throw new ToolError("Nothing to move.", "Pass delta (seconds), start (seconds) and/or trackId.");
    }
    const members = env.requireMany(input.elementIds);
    const anchor = members.reduce((a, b) => (b.element.startTime < a.element.startTime ? b : a));
    const shift = input.start !== undefined
      ? env.snap(input.start) - anchor.element.startTime
      : input.delta !== undefined ? env.snapTicks(anchor.element.startTime + mediaTimeFromSeconds(input.delta)) - anchor.element.startTime : 0;
    const destination = input.trackId === undefined ? undefined : env.requireTrack(input.trackId);

    const moves: PlannedMove[] = members.map((m) => {
      if (destination && destination.type !== trackTypeForElement(m.element.type)) {
        throw new ToolError(`${m.element.type} "${m.element.id}" cannot go on ${destination.type} track "${destination.id}".`, "Choose a track of the matching kind, or move clips of different kinds separately.");
      }
      const toTrackId = destination?.id ?? m.track.id;
      const requested = m.element.startTime + shift;
      if (requested < 0) {
        throw new ToolError(`Moving "${m.element.id}" would start it at ${toSec(requested)}s, before the timeline start.`, `Use a delta of at least ${toSec(-m.element.startTime)}s for this clip.`);
      }
      const startTime = enforceMainTrackStart({ tracks: env.tracks, trackId: toTrackId, requestedStart: requested, excludeElementId: m.element.id });
      return { ref: m.ref, toTrackId, startTime };
    });
    assertNoOverlap(env, moves, members);
    const plan = { moves, createTracks: [] };
    if (!planChangesAnything({ tracks: env.tracks, plan })) return ok("Nothing moved: clips are already there.", { moved: [] });
    env.editor.execute(moveElements(plan));
    const moved = members.map((m) => {
      const now = env.require(m.element.id);
      return { elementId: now.element.id, trackId: now.track.id, start: toSec(now.element.startTime), end: toSec(elementEnd(now.element)) };
    });
    return ok(`Moved ${moved.length} clip(s)${shift !== 0 ? ` by ${toSec(shift)}s` : ""}${destination ? ` to track ${destination.id}` : ""}.`, { shiftSeconds: toSec(shift), moved });
  },
});

function assertNoOverlap(env: ToolEnv, moves: ReadonlyArray<PlannedMove>, members: ReadonlyArray<LocatedElement>): void {
  const movingIds = new Set(members.map((m) => m.element.id));
  const placed: Array<{ id: string; trackId: string; start: number; end: number }> = [];
  for (const { element, track } of allElements(env.tracks)) {
    if (!movingIds.has(element.id)) placed.push({ id: element.id, trackId: track.id, start: element.startTime, end: elementEnd(element) });
  }
  for (const m of moves) {
    const element = members.find((x) => x.ref.elementId === m.ref.elementId)?.element as TimelineElement;
    const entry = { id: element.id, trackId: m.toTrackId, start: m.startTime as number, end: m.startTime + element.duration };
    const clash = placed.find((p) => p.trackId === entry.trackId && intervalsOverlap(p, entry));
    if (clash) {
      throw new ToolError(
        `Moving "${entry.id}" to ${toSec(entry.start)}s-${toSec(entry.end)}s on track ${entry.trackId} would overlap "${clash.id}" (${toSec(clash.start)}s-${toSec(clash.end)}s).`,
        "Clips on one track cannot overlap. Choose a free start (see `gaps` in get_timeline) or another trackId.",
      );
    }
    placed.push(entry);
  }
}

const deleteTool = defineTool<{ elementIds: string[]; ripple?: boolean }>({
  name: "delete",
  description:
    "Delete clips by id. With `ripple:true` later content on the affected tracks shifts earlier to close the gap (times in SECONDS stay consistent); default false leaves a gap. Empty overlay/audio tracks are removed automatically. Media assets stay in the project.",
  inputSchema: {
    type: "object",
    properties: { elementIds: { ...ELEMENT_IDS, description: "Clips to delete." }, ripple: { type: "boolean", description: "Close the gap left behind." } },
    required: ["elementIds"],
  },
  readOnly: false,
  run(input, env) {
    env.requireProject();
    if (input.elementIds.length === 0) throw new ToolError("elementIds is empty.", "Pass at least one element id.");
    const targets = env.requireMany(input.elementIds);
    const previousRipple = env.editor.getState().rippleEnabled;
    env.editor.setRippleEnabled(input.ripple === true);
    try {
      env.editor.execute(deleteElements(targets.map((t) => t.ref)));
    } finally {
      env.editor.setRippleEnabled(previousRipple);
    }
    const deleted = targets.map((t) => ({ elementId: t.element.id, type: t.element.type, name: t.element.name, start: toSec(t.element.startTime), end: toSec(elementEnd(t.element)) }));
    return ok(`Deleted ${deleted.length} clip(s)${input.ripple ? " with ripple" : ""}; timeline is now ${toSec(env.editor.duration())}s.`, { deleted, ripple: input.ripple === true, durationSeconds: toSec(env.editor.duration()) });
  },
});

const duplicate = defineTool<{ elementIds: string[] }>({
  name: "duplicate",
  description:
    "Copy clips (with params, keyframes, effects, masks). Copies keep their timeline time and are placed on a NEW track above, so nothing overlaps; use move afterwards to position them. Returns the new element ids with start/end in SECONDS.",
  inputSchema: { type: "object", properties: { elementIds: ELEMENT_IDS }, required: ["elementIds"] },
  readOnly: false,
  run(input, env) {
    env.requireProject();
    if (input.elementIds.length === 0) throw new ToolError("elementIds is empty.", "Pass at least one element id.");
    const targets = env.requireMany(input.elementIds);
    env.editor.execute(duplicateCommand(targets.map((t) => t.ref)));
    const refs: ElementRef[] = env.editor.selectionRefs();
    const copies = refs.map((ref) => env.require(ref.elementId)).map((l) => ({
      elementId: l.element.id, trackId: l.track.id, name: l.element.name, start: toSec(l.element.startTime), end: toSec(elementEnd(l.element)),
    }));
    return ok(`Duplicated ${copies.length} clip(s).`, { copies });
  },
});

const setSpeed = defineTool<{ elementId: string; speed: number; maintainPitch?: boolean }>({
  name: "set_speed",
  description: `Change playback speed of a video or audio clip (1 = normal, 2 = twice as fast and half as long). Range ${RETIME_MIN}-${RETIME_MAX}. The clip's timeline duration in SECONDS is re-derived from the source; it stops short of the next clip on the track (data.limitedByNeighbour).`,
  inputSchema: {
    type: "object",
    properties: {
      elementId: { type: "string" },
      speed: { type: "number", minimum: RETIME_MIN, maximum: RETIME_MAX, description: "Rate multiplier." },
      maintainPitch: { type: "boolean", description: "Keep audio pitch (default off)." },
    },
    required: ["elementId", "speed"],
  },
  readOnly: false,
  run(input, env) {
    env.requireProject();
    const located = env.require(input.elementId);
    const element = located.element;
    if (!isRetimable(element)) {
      throw new ToolError(`Speed cannot be changed on a ${element.type} clip.`, "Only video and audio clips have a speed. For text/graphics change duration with trim.");
    }
    const previous = "retime" in element ? element.retime : undefined;
    const retime = input.speed === 1 ? undefined : { rate: input.speed, ...(input.maintainPitch === undefined ? {} : { maintainPitch: input.maintainPitch }) };
    const expected = timelineDurationForSourceSpan(Math.round(sourceSpanAtClipTime(element.duration, previous, element.trimStart)), retime, element.trimStart);
    env.editor.execute(updateElements([{ ref: located.ref, patch: { retime } }], "Change speed"));
    const after = env.require(input.elementId).element;
    const limited = after.duration < expected - 1;
    const data = {
      elementId: after.id, speed: input.speed, start: toSec(after.startTime), end: toSec(elementEnd(after)),
      duration: toSec(after.duration), previousDuration: toSec(element.duration), limitedByNeighbour: limited,
    };
    return ok(
      `Set speed of ${after.id} to ${input.speed}x; duration ${data.previousDuration}s -> ${data.duration}s${limited ? " (limited by the next clip; the tail of the source is trimmed)" : ""}.`,
      data,
    );
  },
});

export const EDIT_TOOLS: AgentTool[] = [split, trim, move, deleteTool, duplicate, setSpeed];
