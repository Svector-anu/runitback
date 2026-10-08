import { mediaTime, roundMediaTime } from "#/engine/time";
import { clampAnimationsToDuration } from "#/engine/animation";
import {
  clampRate, InvalidInputError, type ElementPatch, type ElementRef, type IdGenerator, type SceneTracks, type TimelineElement,
} from "#/engine/model";
import { guardElementPatch } from "./input-guards";
import { enforceMainTrackStart } from "./placement";
import { effectiveRate, sourceSpanAtClipTime } from "./retime";
import { elementEnd, findTrack, getElement, replaceElement } from "./tracks";

function merge(element: TimelineElement, patch: ElementPatch): TimelineElement {
  const next: Record<string, unknown> = { ...element };
  for (const [key, value] of Object.entries(patch)) {
    if (key === "params") continue;
    if (value === undefined) delete next[key];
    else next[key] = value;
  }
  if (patch.params) next.params = { ...element.params, ...patch.params };
  return next as unknown as TimelineElement;
}

function sourceLengthOf(element: TimelineElement): number {
  if (element.sourceDuration !== undefined) return element.sourceDuration;
  const retime = "retime" in element ? element.retime : undefined;
  return element.trimStart + sourceSpanAtClipTime(element.duration, retime) + element.trimEnd;
}

/**
 * A duration patch on trimmed media keeps `trimStart + duration * rate + trimEnd == sourceDuration` by moving the
 * tail trim. A duration that needs more source than exists is rejected.
 */
function reconcileTrimWithDuration(element: TimelineElement): TimelineElement {
  if ((element.type !== "video" && element.type !== "audio") || element.sourceDuration === undefined) return element;
  const rate = effectiveRate(element.retime);
  const tail = element.sourceDuration - element.trimStart - element.duration * rate;
  if (Math.abs(tail - element.trimEnd) <= 2 + rate) return element;
  if (tail < -(2 + rate)) {
    throw new InvalidInputError(`duration ${element.duration} needs more media than the source has (${element.sourceDuration} ticks)`);
  }
  return { ...element, trimEnd: mediaTime(Math.max(0, Math.round(tail))) };
}

/** Nearest start of a following sibling on the same track, or Infinity. */
function nextNeighbourStart(tracks: SceneTracks, ref: ElementRef, element: TimelineElement): number {
  const track = findTrack(tracks, ref.trackId);
  let limit = Infinity;
  for (const other of (track?.elements ?? []) as TimelineElement[]) {
    if (other.id !== element.id && other.startTime >= elementEnd(element) - 1 && other.startTime >= element.startTime) {
      limit = Math.min(limit, other.startTime);
    }
  }
  return limit;
}

/**
 * Applies a patch with the derivation and enforcement rules every edit path shares:
 * speed changes re-derive duration (never past a following neighbour), duration changes clamp animation,
 * start times are non-negative and obey the main-track start rule.
 */
export function applyElementUpdate(input: {
  tracks: SceneTracks; ref: ElementRef; patch: ElementPatch; newId: IdGenerator;
}): SceneTracks {
  const { tracks, ref, patch } = input;
  const element = getElement(tracks, ref);
  guardElementPatch(patch);
  if (!element) return tracks;
  let next = merge(element, patch);

  if ("retime" in patch && (element.type === "video" || element.type === "audio")) {
    const rate = next.type === "video" || next.type === "audio" ? effectiveRate(next.retime) : 1;
    const total = sourceLengthOf(element);
    const visible = Math.max(0, total - next.trimStart - next.trimEnd);
    let duration = roundMediaTime(visible / clampRate(rate));
    const room = nextNeighbourStart(tracks, ref, element) - next.startTime;
    if (duration > room) {
      duration = mediaTime(Math.max(0, Math.floor(room)));
      next = { ...next, trimEnd: mediaTime(Math.max(0, Math.round(total - next.trimStart - duration * rate))) };
    }
    next = { ...next, duration };
  }

  if (patch.duration !== undefined && patch.trimEnd === undefined && !("retime" in patch)) {
    next = reconcileTrimWithDuration(next);
  }

  if (next.duration !== element.duration) {
    const animations = clampAnimationsToDuration({ animations: next.animations, duration: next.duration, newId: input.newId });
    next = { ...next };
    if (animations) next.animations = animations;
    else delete next.animations;
  }

  if (patch.startTime !== undefined) {
    const requested = Math.max(0, next.startTime);
    const start = enforceMainTrackStart({ tracks, trackId: ref.trackId, requestedStart: requested, excludeElementId: element.id });
    next = { ...next, startTime: start };
  }
  return replaceElement(tracks, ref, next);
}
