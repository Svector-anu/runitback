import { mediaTime, roundMediaTime } from "#/engine/time";
import { splitAnimationsAtTime } from "#/engine/animation";
import type { ElementRef, IdGenerator, RetimeConfig, SceneTracks, TimelineElement } from "#/engine/model";
import { clipTimeAtSource, sourceSpanAtClipTime, sourceTimeAt, withDerivedRate } from "./retime";
import { elementEnd, mapTracks, withElements } from "./tracks";

export type RetainSide = "both" | "left" | "right";

export interface SplitResult {
  tracks: SceneTracks;
  /** Elements that should become the selection after the split. */
  selection: ElementRef[];
  /** True when at least one element was cut. */
  changed: boolean;
}

function retimeOf(element: TimelineElement) {
  return "retime" in element ? element.retime : undefined;
}

/**
 * Rounding the cut position to a whole source tick shifts the right half by up to half a tick of source, which a slow
 * stretch of the curve turns into several ticks of timeline and a following fast stretch into several more of source.
 * The halves keep their cut point and start; their tails are re-derived from the curve so that
 * `trimStart + mapped span + trimEnd == sourceDuration` still holds for each (the right half gives up, at most, a few
 * ticks at its far end rather than breaking the invariant).
 */
function reconcileCurvedHalves(input: { left: TimelineElement; right: TimelineElement; retime: RetimeConfig; sourceDuration: number }): void {
  const { left, right, retime, sourceDuration } = input;
  for (const half of [left, right]) {
    if (half.type !== "video" && half.type !== "audio") continue;
    let end = Math.round(sourceTimeAt({ trimStart: half.trimStart, clipTime: half.duration, retime }));
    if (end > sourceDuration + 1) {
      half.duration = mediaTime(Math.max(1, Math.floor(clipTimeAtSource({ trimStart: half.trimStart, source: sourceDuration, retime }))));
      end = Math.min(sourceDuration, Math.round(sourceTimeAt({ trimStart: half.trimStart, clipTime: half.duration, retime })));
    }
    half.trimEnd = mediaTime(Math.max(0, sourceDuration - end));
  }
}

function cut(element: TimelineElement, splitTime: number, newId: IdGenerator): { left: TimelineElement; right: TimelineElement } {
  const rel = splitTime - element.startTime;
  const rightDuration = element.duration - rel;
  const isMedia = element.type === "video" || element.type === "audio";
  const retime = retimeOf(element);
  const leftSource = roundMediaTime(sourceSpanAtClipTime(rel, retime, element.trimStart));
  const totalSource = roundMediaTime(sourceSpanAtClipTime(element.duration, retime, element.trimStart));
  const rightSource = totalSource - leftSource;
  const anims = splitAnimationsAtTime({ animations: element.animations, splitTime: rel, includeBoundary: true, newId });

  const left = { ...element, duration: mediaTime(rel), name: `${element.name} (left)` } as TimelineElement;
  const right = {
    ...element,
    id: newId(),
    startTime: mediaTime(splitTime),
    duration: mediaTime(rightDuration),
    name: `${element.name} (right)`,
  } as TimelineElement;
  if (isMedia) {
    left.trimEnd = mediaTime(element.trimEnd + rightSource);
    right.trimStart = mediaTime(element.trimStart + leftSource);
    if (retime?.curve && element.sourceDuration !== undefined) reconcileCurvedHalves({ left, right, retime, sourceDuration: element.sourceDuration });
  }
  delete left.animations;
  delete right.animations;
  delete (right as { transition?: unknown }).transition;
  delete (left as { textAnimation?: unknown }).textAnimation;
  delete (right as { textAnimation?: unknown }).textAnimation;
  if (anims.left) left.animations = anims.left;
  if (anims.right) right.animations = anims.right;
  return { left: withDerivedRate(left as TimelineElement & { trimStart: number }) as TimelineElement, right: withDerivedRate(right as TimelineElement & { trimStart: number }) as TimelineElement };
}

export function splitElements(input: {
  tracks: SceneTracks; refs: ReadonlyArray<ElementRef>; splitTime: number; retainSide?: RetainSide; newId: IdGenerator;
}): SplitResult {
  const side = input.retainSide ?? "both";
  const wanted = new Set(input.refs.map((r) => `${r.trackId}/${r.elementId}`));
  const selection: ElementRef[] = [];
  let changed = false;

  const tracks = mapTracks(input.tracks, (track) => {
    const out: TimelineElement[] = [];
    for (const element of track.elements as TimelineElement[]) {
      const targeted = wanted.has(`${track.id}/${element.id}`);
      if (!targeted || input.splitTime <= element.startTime || input.splitTime >= elementEnd(element)) {
        out.push(element);
        continue;
      }
      changed = true;
      const { left, right } = cut(element, input.splitTime, input.newId);
      if (side === "both") {
        out.push(left, right);
        selection.push({ trackId: track.id, elementId: right.id });
      } else if (side === "left") {
        out.push(left);
        selection.push({ trackId: track.id, elementId: left.id });
      } else {
        out.push(right);
        selection.push({ trackId: track.id, elementId: right.id });
      }
    }
    return withElements(track, out);
  });
  return { tracks: changed ? tracks : input.tracks, selection, changed };
}
