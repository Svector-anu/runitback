import {
  addTrack, batch, insertElement, removeTrackCommand, setTrackFlags, toggleBookmark, updateBookmark, updateSettings, type Command,
} from "#/engine/commands";
import { parseAss, parseSrt } from "#/engine/captions";
import {
  CANVAS_PRESETS, EMPTY_SELECTION, canTrackBeHidden, canTrackHaveAudio, type GradientBackground, type GradientStyle, type ProjectSettings,
} from "#/engine/model";
import { DEFAULT_GRADIENT, gradientProblem } from "#/engine/render";
import { allElements } from "#/engine/timeline";
import { frameIndexAt, frameRateFromFloat, frameRateToFloat, mediaTime, mediaTimeFromSeconds } from "#/engine/time";
import { captionElement } from "./captions";
import { defineTool, ok, toSec, ToolError } from "./env";
import type { AgentTool } from "./types";

const HEX_COLOR = /^#(?:[0-9a-f]{6}|[0-9a-f]{8})$/i;

/** The entries of `value` that are not undefined, so a partial input never overwrites a default with undefined. */
const definedOnly = <T extends object>(value: T): Partial<T> => Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Partial<T>;

const setTrack = defineTool<{ trackId: string; muted?: boolean; hidden?: boolean }>({
  name: "set_track",
  description: "Mute/unmute (`muted`) and/or hide/show (`hidden`) a whole track by id. Only video and audio tracks can be muted; every track except audio can be hidden. Absolute values, not toggles.",
  inputSchema: {
    type: "object",
    properties: { trackId: { type: "string" }, muted: { type: "boolean" }, hidden: { type: "boolean" } },
    required: ["trackId"],
  },
  readOnly: false,
  run(input, env) {
    env.requireProject();
    if (input.muted === undefined && input.hidden === undefined) throw new ToolError("Nothing to change.", "Pass muted and/or hidden.");
    const track = env.requireTrack(input.trackId);
    if (input.muted !== undefined && !canTrackHaveAudio(track)) {
      throw new ToolError(`A ${track.type} track has no audio to mute.`, "Only video and audio tracks can be muted.");
    }
    if (input.hidden !== undefined && !canTrackBeHidden(track)) {
      throw new ToolError(`An ${track.type} track cannot be hidden.`, "Use muted for audio tracks.");
    }
    env.editor.execute(setTrackFlags({ trackId: track.id, muted: input.muted, hidden: input.hidden }));
    const after = env.requireTrack(track.id);
    const data = { trackId: after.id, muted: "muted" in after ? after.muted : undefined, hidden: "hidden" in after ? after.hidden : undefined };
    return ok(`Track ${after.id} muted=${String(data.muted)} hidden=${String(data.hidden)}.`, data);
  },
});

const deleteTrack = defineTool<{ trackId: string }>({
  name: "delete_track",
  description: "Delete a whole track and every clip on it (undoable). The main track cannot be deleted; delete its clips instead.",
  inputSchema: { type: "object", properties: { trackId: { type: "string" } }, required: ["trackId"] },
  readOnly: false,
  destructive: true,
  run(input, env) {
    env.requireProject();
    const track = env.requireTrack(input.trackId);
    if (track.id === env.tracks.main.id) {
      throw new ToolError("The main track cannot be deleted.", "Delete its clips with the delete tool instead.");
    }
    const removed = allElements(env.tracks).filter((l) => l.track.id === track.id).map((l) => l.element.id);
    env.editor.execute(removeTrackCommand(track.id));
    return ok(`Deleted track ${track.id} with ${removed.length} clip(s).`, { trackId: track.id, removedElementIds: removed });
  },
});

const PRESET_LABELS = ["16:9", "9:16", "1:1", "4:3"] as const;

const setProject = defineTool<{
  canvasPreset?: (typeof PRESET_LABELS)[number]; width?: number; height?: number; fps?: number;
  backgroundColor?: string; backgroundBlur?: number;
  backgroundGradient?: { style?: GradientStyle; colors?: string[]; angle?: number; motion?: number };
}>({
  name: "set_project",
  description:
    "Change project settings. Canvas: `canvasPreset` 16:9 (1920x1080), 9:16 (1080x1920), 1:1 (1080x1080), 4:3 (1440x1080), or custom `width` AND `height` in pixels (even integers). `fps` is frames per second (e.g. 24, 25, 29.97, 30, 60); changing it changes the frame grid all times snap to. Background (pick one): `backgroundColor` (#rrggbb), `backgroundBlur` (blur intensity 0-100 of the footage) or `backgroundGradient` { style linear|radial|mesh, colors (2-6 of #rrggbb), angle (degrees, linear only; 0 = towards the top, 90 = towards the right), motion (0-100, drifts the gradient over time; 0 = still) }. Clip positions are not rescaled.",
  inputSchema: {
    type: "object",
    properties: {
      canvasPreset: { type: "string", enum: [...PRESET_LABELS] },
      width: { type: "integer", minimum: 16, maximum: 8192 },
      height: { type: "integer", minimum: 16, maximum: 8192 },
      fps: { type: "number", minimum: 1, maximum: 120 },
      backgroundColor: { type: "string" },
      backgroundBlur: { type: "number", minimum: 0, maximum: 100 },
      backgroundGradient: { type: "object", description: "{ style, colors, angle, motion }" },
    },
  },
  readOnly: false,
  destructive: true,
  run(input, env) {
    env.requireProject();
    const patch: Partial<ProjectSettings> = {};
    if (input.canvasPreset !== undefined && (input.width !== undefined || input.height !== undefined)) {
      throw new ToolError("Pass either canvasPreset or width/height, not both.", "Use a preset for standard shapes, width+height for custom sizes.");
    }
    if (input.canvasPreset !== undefined) {
      const size = CANVAS_PRESETS[PRESET_LABELS.indexOf(input.canvasPreset)];
      if (size) Object.assign(patch, { canvasSize: { ...size }, canvasSizeMode: "preset" });
    } else if (input.width !== undefined || input.height !== undefined) {
      if (input.width === undefined || input.height === undefined) throw new ToolError("width and height must be given together.", "Pass both, e.g. width 1280 and height 720.");
      if (input.width % 2 !== 0 || input.height % 2 !== 0) throw new ToolError("width and height must be even.", "Video encoders need even dimensions; round up by one pixel.");
      const matching = CANVAS_PRESETS.some((p) => p.width === input.width && p.height === input.height);
      Object.assign(patch, { canvasSize: { width: input.width, height: input.height }, canvasSizeMode: matching ? "preset" : "custom" });
    }
    if (input.fps !== undefined) patch.fps = frameRateFromFloat(input.fps);
    if ([input.backgroundColor, input.backgroundBlur, input.backgroundGradient].filter((v) => v !== undefined).length > 1) {
      throw new ToolError("Pass only one of backgroundColor, backgroundBlur and backgroundGradient.", "A background is a solid colour, a blurred copy of the footage, or a gradient.");
    }
    if (input.backgroundGradient !== undefined) {
      const gradient: GradientBackground = { ...DEFAULT_GRADIENT, ...definedOnly(input.backgroundGradient) };
      const problem = gradientProblem(gradient);
      if (problem) throw new ToolError(`Invalid backgroundGradient: ${problem}.`, "Example: { style: \"mesh\", colors: [\"#0f172a\", \"#7c3aed\", \"#06b6d4\"], motion: 40 }.");
      patch.background = gradient;
    }
    if (input.backgroundColor !== undefined) {
      if (!HEX_COLOR.test(input.backgroundColor)) throw new ToolError(`Invalid backgroundColor "${input.backgroundColor}".`, "Use #rrggbb, e.g. #101820.");
      patch.background = { type: "color", color: input.backgroundColor };
    }
    if (input.backgroundBlur !== undefined) patch.background = { type: "blur", blurIntensity: input.backgroundBlur };
    if (Object.keys(patch).length === 0) throw new ToolError("Nothing to change.", "Pass canvasPreset, width+height, fps, backgroundColor, backgroundBlur or backgroundGradient.");
    env.editor.execute(updateSettings(patch));
    const settings = env.doc.settings;
    const data = {
      canvas: { ...settings.canvasSize }, fps: Math.round(frameRateToFloat(settings.fps) * 1000) / 1000, background: settings.background,
    };
    return ok(`Project is now ${data.canvas.width}x${data.canvas.height} @ ${data.fps} fps.`, data);
  },
});

const addBookmark = defineTool<{ time: number; note?: string; color?: string }>({
  name: "add_bookmark",
  description: "Mark a point on the timeline. `time` is SECONDS (snapped to a frame). Adding at an existing bookmark updates its note/colour instead of removing it.",
  inputSchema: {
    type: "object",
    properties: { time: { type: "number", minimum: 0 }, note: { type: "string" }, color: { type: "string" } },
    required: ["time"],
  },
  readOnly: false,
  run(input, env) {
    env.requireProject();
    const time = env.snap(input.time);
    const exists = env.scene.bookmarks.some((b) => b.time === time);
    const commands: Command[] = [];
    if (!exists) commands.push(toggleBookmark(time));
    if (input.note !== undefined || input.color !== undefined) {
      commands.push(updateBookmark(time, { ...(input.note === undefined ? {} : { note: input.note }), ...(input.color === undefined ? {} : { color: input.color }) }));
    }
    if (commands.length > 0) env.editor.execute(batch("Add bookmark", commands));
    return ok(`Bookmark at ${toSec(time)}s${input.note ? `: ${input.note}` : ""}.`, { time: toSec(time), note: input.note, total: env.scene.bookmarks.length });
  },
});

const importCaptions = defineTool<{ srt?: string; ass?: string; offset?: number }>({
  name: "import_captions",
  description:
    "Create one text clip per subtitle cue on a NEW text track at the top, from SubRip (`srt`) or Advanced SubStation (`ass`) text. Pass exactly one. `offset` shifts all cues by SECONDS (may be negative). Cue times snap to frames; a cue that overlaps the next is shortened to end where the next begins. Returns the track id, cue count and skipped count.",
  inputSchema: {
    type: "object",
    properties: {
      srt: { type: "string", description: "Full .srt file contents." },
      ass: { type: "string", description: "Full .ass/.ssa file contents." },
      offset: { type: "number", description: "Shift in SECONDS." },
    },
  },
  readOnly: false,
  destructive: true,
  run(input, env) {
    env.requireProject();
    if ((input.srt === undefined) === (input.ass === undefined)) {
      throw new ToolError("Pass exactly one of srt or ass.", "Put the whole subtitle file text in `srt` (SubRip) or `ass` (SubStation).");
    }
    const parsed = input.srt !== undefined ? parseSrt(input.srt) : parseAss(input.ass as string);
    if (parsed.cues.length === 0) {
      throw new ToolError("No valid subtitle cues were found.", `Check the format (timestamps like 00:00:01,000 --> 00:00:03,000 for srt). ${parsed.warnings.join(" ")}`.trim());
    }
    const offset = mediaTimeFromSeconds(input.offset ?? 0);
    const frame = env.snapDuration(0);
    const timed = parsed.cues
      .map((cue) => ({ cue, start: env.snap(Math.max(0, (cue.startTime + offset) / 120000)), end: env.snap(Math.max(0, (cue.startTime + cue.duration + offset) / 120000)) }))
      .sort((a, b) => a.start - b.start);
    let shortened = 0;
    const kept = timed.flatMap((entry, i) => {
      const next = timed[i + 1];
      const end = next && next.start < entry.end ? next.start : entry.end;
      if (end !== entry.end) shortened++;
      return end - entry.start >= frame ? [{ cue: entry.cue, start: entry.start, duration: mediaTime(end - entry.start) }] : [];
    });
    if (kept.length === 0) throw new ToolError("Every cue falls before 0s or is shorter than one frame.", "Check `offset` and the cue timestamps.");
    const canvas = env.doc.settings.canvasSize;
    const trackId = env.editor.newId();
    const ids = kept.map(() => env.editor.newId());
    env.editor.execute(batch("Import captions", [
      addTrack({ type: "text", index: 0, trackId }),
      ...kept.map((k, i) => insertElement({
        element: captionElement({ cue: k.cue, index: i, id: ids[i] as string, canvas, startTime: k.start, duration: k.duration }),
        placement: { mode: "explicit", trackId },
      })),
    ]));
    const skipped = parsed.skipped + (parsed.cues.length - kept.length);
    return ok(`Added ${kept.length} caption(s) on track ${trackId}.`, {
      trackId, count: kept.length, firstElementId: ids[0], lastElementId: ids[ids.length - 1],
      start: toSec(kept[0]?.start ?? 0), end: toSec((kept[kept.length - 1]?.start ?? 0) + (kept[kept.length - 1]?.duration ?? 0)),
      skipped, shortenedOverlaps: shortened, warnings: parsed.warnings,
    });
  },
});

const seek = defineTool<{ time: number }>({
  name: "seek",
  description: "Move the playhead to `time` SECONDS (snapped to a frame, clamped to the timeline duration) and pause playback. Not an edit; creates no undo step.",
  inputSchema: { type: "object", properties: { time: { type: "number", minimum: 0 } }, required: ["time"] },
  readOnly: true,
  run(input, env) {
    env.requireProject();
    env.editor.playback.pause();
    env.editor.playback.seek(env.snap(input.time));
    const now = env.playhead;
    const clamped = now !== env.snap(input.time);
    return ok(`Playhead at ${toSec(now)}s${clamped ? " (clamped to the timeline end)" : ""}.`, {
      seconds: toSec(now), frame: frameIndexAt(now, env.fps), clamped, durationSeconds: toSec(env.editor.duration()),
    });
  },
});

const select = defineTool<{ elementIds: string[] }>({
  name: "select",
  description: "Select clips by id in the editor UI (empty array clears the selection). Selection is not an edit and creates no undo step.",
  inputSchema: { type: "object", properties: { elementIds: { type: "array", items: { type: "string" } } }, required: ["elementIds"] },
  readOnly: true,
  run(input, env) {
    env.requireProject();
    const located = env.requireMany(input.elementIds);
    env.editor.setSelection({ ...EMPTY_SELECTION, elements: located.map((l) => l.ref) });
    return ok(located.length === 0 ? "Selection cleared." : `Selected ${located.length} clip(s).`, { elementIds: located.map((l) => l.element.id) });
  },
});

function stepper(direction: "undo" | "redo") {
  return defineTool<{ steps?: number }>({
    name: direction,
    description: direction === "undo"
      ? "Undo the last `steps` (default 1) completed edit steps. One agent turn counts as one step. Inside an open turn only that turn's own steps can be undone."
      : "Redo the last `steps` (default 1) undone steps.",
    inputSchema: { type: "object", properties: { steps: { type: "integer", minimum: 1, maximum: 50 } } },
    readOnly: false,
    destructive: true,
    run(input, env) {
      env.requireProject();
      const wanted = input.steps ?? 1;
      let done = 0;
      while (done < wanted && (direction === "undo" ? env.editor.undo() : env.editor.redo())) done++;
      if (done === 0) {
        throw new ToolError(
          direction === "undo" ? "Nothing to undo." : "Nothing to redo.",
          env.editor.inTransaction ? "Inside a turn only the turn's own steps can be undone or redone." : direction === "undo" ? "The history is empty." : "Redo is only available right after an undo.",
        );
      }
      const state = env.editor.getState();
      return ok(`${direction === "undo" ? "Undid" : "Redid"} ${done} step(s).`, { steps: done, canUndo: state.canUndo, canRedo: state.canRedo, durationSeconds: toSec(env.editor.duration()) });
    },
  });
}

export const PROJECT_TOOLS: AgentTool[] = [
  setTrack, deleteTrack, setProject, addBookmark, importCaptions, seek, select, stepper("undo"), stepper("redo"),
];
