import { mediaTime, roundMediaTime } from "#/engine/time";
import { splitAnimationsAtTime } from "#/engine/animation";
import type { ElementRef, IdGenerator, SceneTracks, TimelineElement } from "#/engine/model";
import { sourceSpanAtClipTime } from "./retime";
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

function cut(element: TimelineElement, splitTime: number, newId: IdGenerator): { left: TimelineElement; right: TimelineElement } {
  const rel = splitTime - element.startTime;
  const rightDuration = element.duration - rel;
  const isMedia = element.type === "video" || element.type === "audio";
  const retime = retimeOf(element);
  const leftSource = roundMediaTime(sourceSpanAtClipTime(rel, retime));
  const totalSource = roundMediaTime(sourceSpanAtClipTime(element.duration, retime));
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
  }
  delete left.animations;
  delete right.animations;
  delete (right as { transition?: unknown }).transition;
  delete (left as { textAnimation?: unknown }).textAnimation;
  delete (right as { textAnimation?: unknown }).textAnimation;
  if (anims.left) left.animations = anims.left;
  if (anims.right) right.animations = anims.right;
  return { left, right };
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
