import { mediaTime, roundMediaTime, type FrameRate } from "#/engine/time";
import { frameDuration } from "#/engine/time";
import type { ElementPatch, ElementRef, SceneTracks, TimelineElement } from "#/engine/model";
import { sourceSpanAtClipTime, timelineDurationForSourceSpan } from "./retime";
import { elementEnd, findTrack } from "./tracks";

export type ResizeSide = "left" | "right";

export interface ResizeMember {
  ref: ElementRef;
  element: TimelineElement;
  /** End of the nearest non-selected element before this one, or null. */
  leftNeighborEnd: number | null;
  /** Start of the nearest non-selected element after this one, or null. */
  rightNeighborStart: number | null;
}

export interface ResizeResult {
  delta: number;
  patches: Array<{ ref: ElementRef; patch: ElementPatch }>;
}

function retimeOf(element: TimelineElement) {
  return "retime" in element ? element.retime : undefined;
}

function hasSource(element: TimelineElement): boolean {
  return element.sourceDuration !== undefined;
}

export function buildResizeMembers(input: { tracks: SceneTracks; refs: ReadonlyArray<ElementRef> }): ResizeMember[] {
  const selected = new Set(input.refs.map((r) => `${r.trackId}/${r.elementId}`));
  const members: ResizeMember[] = [];
  for (const ref of input.refs) {
    const track = findTrack(input.tracks, ref.trackId);
    const element = (track?.elements as TimelineElement[] | undefined)?.find((e) => e.id === ref.elementId);
    if (!track || !element) continue;
    let leftEnd: number | null = null;
    let rightStart: number | null = null;
    for (const other of track.elements as TimelineElement[]) {
      if (selected.has(`${track.id}/${other.id}`) || other.id === element.id) continue;
      if (elementEnd(other) <= element.startTime) leftEnd = leftEnd === null ? elementEnd(other) : Math.max(leftEnd, elementEnd(other));
      else if (other.startTime >= elementEnd(element)) rightStart = rightStart === null ? other.startTime : Math.min(rightStart, other.startTime);
    }
    members.push({ ref, element, leftNeighborEnd: leftEnd, rightNeighborStart: rightStart });
  }
  return members;
}

/** Allowed delta range for the dragged edge of one member. */
export function memberDeltaRange(input: { member: ResizeMember; side: ResizeSide; minDuration: number }): { min: number; max: number } {
  const { member, side, minDuration } = input;
  const e = member.element;
  const retime = retimeOf(e);
  if (side === "left") {
    const byNeighbour = member.leftNeighborEnd !== null ? member.leftNeighborEnd - e.startTime : -e.startTime;
    const bySource = hasSource(e) ? -timelineDurationForSourceSpan(e.trimStart, retime) : -Infinity;
    return { min: Math.max(byNeighbour, bySource), max: e.duration - minDuration };
  }
  const byNeighbour = member.rightNeighborStart !== null ? member.rightNeighborStart - elementEnd(e) : Infinity;
  const bySource = hasSource(e) ? timelineDurationForSourceSpan(e.trimEnd, retime) : Infinity;
  return { min: minDuration - e.duration, max: Math.min(byNeighbour, bySource) };
}

function roundToFrames(delta: number, frame: number): number {
  return Math.sign(delta) * Math.round(Math.abs(delta) / frame) * frame;
}

export function computeGroupResize(input: {
  members: ReadonlyArray<ResizeMember>; side: ResizeSide; delta: number; fps: FrameRate;
}): ResizeResult {
  const minDuration = frameDuration(input.fps);
  const ranges = input.members.map((member) => memberDeltaRange({ member, side: input.side, minDuration }));
  const lo = Math.max(...ranges.map((r) => r.min));
  const hi = Math.min(...ranges.map((r) => r.max));
  const clamp = (d: number): number => (lo > hi ? 0 : Math.min(hi, Math.max(lo, d)));

  let delta = clamp(input.delta);
  delta = clamp(roundToFrames(delta, minDuration));
  delta = Math.round(delta);

  const patches = input.members.map(({ ref, element }) => {
    const retime = retimeOf(element);
    const media = hasSource(element);
    const sourceDelta = media ? roundMediaTime(Math.sign(delta) * sourceSpanAtClipTime(Math.abs(delta), retime)) : 0;
    const patch: ElementPatch = input.side === "left"
      ? {
        startTime: mediaTime(element.startTime + delta),
        duration: mediaTime(element.duration - delta),
        ...(media ? { trimStart: mediaTime(Math.max(0, element.trimStart + sourceDelta)) } : {}),
      }
      : {
        duration: mediaTime(element.duration + delta),
        ...(media ? { trimEnd: mediaTime(Math.max(0, element.trimEnd - sourceDelta)) } : {}),
      };
    return { ref, patch };
  });
  return { delta, patches };
}
