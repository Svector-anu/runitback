import { updateElements, type Command, type ElementUpdate } from "#/engine/commands";
import { mediaTime, mediaTimeFromSeconds, roundMediaTime, roundToFrame, frameDuration, type FrameRate } from "#/engine/time";
import type { ElementPatch, SceneTracks, TimelineElement } from "#/engine/model";
import { elementEnd, sourceSpanAtClipTime, timelineDurationForSourceSpan } from "#/engine/timeline";

export const BEAT_SNAP_DEFAULT_TOLERANCE_SECONDS = 0.15;
export const BEAT_SNAP_MAX_TOLERANCE_SECONDS = 0.5;
/** Two clip edges closer than this (ticks) are one cut; anything wider is a gap, which is not a cut. */
const TOUCHING_TICKS = 1;

export type BeatSnapSkipReason = "no-beat-in-tolerance" | "already-on-beat" | "not-enough-media" | "clip-too-short";

export interface BeatSnapMove {
  trackId: string;
  leftId: string;
  rightId: string;
  fromTicks: number;
  toTicks: number;
}

export interface BeatSnapSkip {
  trackId: string;
  leftId: string;
  rightId: string;
  atTicks: number;
  reason: BeatSnapSkipReason;
}

export interface BeatSnapPlan {
  /** Cuts that were candidates (touching clips on a video track, filtered by the selection). */
  cutCount: number;
  moves: BeatSnapMove[];
  skipped: BeatSnapSkip[];
  /** One merged patch per touched clip; apply with `updateElements`. */
  updates: ElementUpdate[];
}

interface Sim {
  ref: { trackId: string; elementId: string };
  element: TimelineElement;
  startTime: number;
  duration: number;
  trimStart: number;
  trimEnd: number;
  touched: boolean;
}

const hasSource = (e: TimelineElement): boolean => e.sourceDuration !== undefined;
const retimeOf = (e: TimelineElement) => ("retime" in e ? e.retime : undefined);

function nearestBeat(beats: ReadonlyArray<number>, at: number): number | undefined {
  let lo = 0;
  let hi = beats.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((beats[mid] as number) < at) lo = mid + 1;
    else hi = mid;
  }
  const candidates = [beats[lo - 1], beats[lo]].filter((b): b is number => b !== undefined);
  return candidates.sort((a, b) => Math.abs(a - at) - Math.abs(b - at))[0];
}

/** Largest rightward and leftward shift (ticks) a rolling edit between `left` and `right` can take. */
function shiftRange(input: { left: Sim; right: Sim; minDuration: number }): { min: number; max: number } {
  const { left, right, minDuration } = input;
  const leftGrow = hasSource(left.element) ? timelineDurationForSourceSpan(left.trimEnd, retimeOf(left.element)) : Infinity;
  const rightGrow = hasSource(right.element) ? timelineDurationForSourceSpan(right.trimStart, retimeOf(right.element)) : Infinity;
  return {
    min: Math.max(-(left.duration - minDuration), -rightGrow),
    max: Math.min(right.duration - minDuration, leftGrow),
  };
}

function applyRoll(input: { left: Sim; right: Sim; delta: number }): void {
  const { left, right, delta } = input;
  left.duration += delta;
  if (hasSource(left.element)) {
    const source = roundMediaTime(Math.sign(delta) * sourceSpanAtClipTime(Math.abs(delta), retimeOf(left.element)));
    left.trimEnd = Math.max(0, left.trimEnd - source);
  }
  right.startTime += delta;
  right.duration -= delta;
  if (hasSource(right.element)) {
    const source = roundMediaTime(Math.sign(delta) * sourceSpanAtClipTime(Math.abs(delta), retimeOf(right.element)));
    right.trimStart = Math.max(0, right.trimStart + source);
  }
  left.touched = true;
  right.touched = true;
}

function patchOf(sim: Sim): ElementPatch {
  const patch: ElementPatch = { startTime: mediaTime(sim.startTime), duration: mediaTime(sim.duration) };
  if (hasSource(sim.element)) {
    patch.trimStart = mediaTime(sim.trimStart);
    patch.trimEnd = mediaTime(sim.trimEnd);
  }
  return patch;
}

/**
 * Rolling edits that move each cut (the shared edge of two touching clips on a video track) to the nearest beat within
 * `toleranceSeconds`. The left clip's tail and the right clip's head move together, so the track length, every other
 * clip and the no-overlap rule are untouched, and trims move with the edge so `trimStart + duration * rate + trimEnd`
 * stays equal to the source length. A cut is left alone when the media has no spare frames to grow into, or when
 * moving it would shrink a neighbour below one frame. Only cuts at whose edge a selected clip sits are considered
 * when `elementIds` is given.
 */
export function planBeatSnap(input: {
  tracks: SceneTracks; beatsSeconds: ReadonlyArray<number>; toleranceSeconds: number; fps: FrameRate; elementIds?: ReadonlyArray<string>;
}): BeatSnapPlan {
  const minDuration = frameDuration(input.fps);
  const tolerance = mediaTimeFromSeconds(Math.min(Math.max(input.toleranceSeconds, 0), BEAT_SNAP_MAX_TOLERANCE_SECONDS));
  const beats = [...new Set(input.beatsSeconds.map((s) => roundToFrame(mediaTimeFromSeconds(s), input.fps)))].sort((a, b) => a - b);
  const selected = input.elementIds ? new Set(input.elementIds) : null;
  const plan: BeatSnapPlan = { cutCount: 0, moves: [], skipped: [], updates: [] };
  const sims = new Map<string, Sim>();
  const simOf = (trackId: string, element: TimelineElement): Sim => {
    const key = `${trackId}/${element.id}`;
    let sim = sims.get(key);
    if (!sim) {
      sim = { ref: { trackId, elementId: element.id }, element, startTime: element.startTime, duration: element.duration, trimStart: element.trimStart, trimEnd: element.trimEnd, touched: false };
      sims.set(key, sim);
    }
    return sim;
  };

  for (const track of [...input.tracks.overlay, input.tracks.main]) {
    if (track.type !== "video") continue;
    const ordered = [...(track.elements as TimelineElement[])].sort((a, b) => a.startTime - b.startTime);
    for (let i = 0; i + 1 < ordered.length; i++) {
      const leftEl = ordered[i] as TimelineElement;
      const rightEl = ordered[i + 1] as TimelineElement;
      if (Math.abs(elementEnd(leftEl) - rightEl.startTime) > TOUCHING_TICKS) continue;
      if (selected && !selected.has(leftEl.id) && !selected.has(rightEl.id)) continue;
      plan.cutCount++;
      const left = simOf(track.id, leftEl);
      const right = simOf(track.id, rightEl);
      const at = right.startTime;
      const base = { trackId: track.id, leftId: leftEl.id, rightId: rightEl.id, atTicks: at };
      const beat = nearestBeat(beats, at);
      if (beat === undefined || Math.abs(beat - at) > tolerance) {
        plan.skipped.push({ ...base, reason: "no-beat-in-tolerance" });
        continue;
      }
      const delta = beat - at;
      if (delta === 0) {
        plan.skipped.push({ ...base, reason: "already-on-beat" });
        continue;
      }
      const range = shiftRange({ left, right, minDuration });
      if (delta < range.min || delta > range.max) {
        const shrinks = delta > 0 ? right.duration - delta < minDuration : left.duration + delta < minDuration;
        plan.skipped.push({ ...base, reason: shrinks ? "clip-too-short" : "not-enough-media" });
        continue;
      }
      applyRoll({ left, right, delta });
      plan.moves.push({ trackId: track.id, leftId: leftEl.id, rightId: rightEl.id, fromTicks: at, toTicks: beat });
    }
  }
  plan.updates = [...sims.values()].filter((s) => s.touched).map((s) => ({ ref: s.ref, patch: patchOf(s) }));
  return plan;
}

export function snapCutsToBeatCommand(plan: BeatSnapPlan): Command {
  return updateElements(plan.updates, "Snap cuts to beat");
}
