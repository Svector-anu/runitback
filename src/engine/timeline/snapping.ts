import { roundMediaTime } from "#/engine/time";
import { listKeyframes } from "#/engine/animation";
import { orderedTracks, type Bookmark, type SceneTracks, type TimelineElement } from "#/engine/model";
import { elementEnd } from "./tracks";

export type SnapPointType = "element-start" | "element-end" | "playhead" | "bookmark" | "keyframe";

export interface SnapPoint {
  time: number;
  type: SnapPointType;
  elementId?: string;
  trackId?: string;
}

export interface SnapResult {
  snappedTime: number;
  snapPoint: SnapPoint | null;
  distance: number;
}

export function elementSnapPoints(input: { tracks: SceneTracks; excludeElementIds?: ReadonlySet<string> }): SnapPoint[] {
  const points: SnapPoint[] = [];
  for (const track of orderedTracks(input.tracks)) {
    for (const element of track.elements as TimelineElement[]) {
      if (input.excludeElementIds?.has(element.id)) continue;
      points.push(
        { time: element.startTime, type: "element-start", elementId: element.id, trackId: track.id },
        { time: elementEnd(element), type: "element-end", elementId: element.id, trackId: track.id },
      );
    }
  }
  return points;
}

export function keyframeSnapPoints(input: { tracks: SceneTracks; excludeElementIds?: ReadonlySet<string> }): SnapPoint[] {
  const points: SnapPoint[] = [];
  for (const track of orderedTracks(input.tracks)) {
    for (const element of track.elements as TimelineElement[]) {
      if (input.excludeElementIds?.has(element.id)) continue;
      for (const key of listKeyframes(element.animations)) {
        points.push({ time: element.startTime + key.time, type: "keyframe", elementId: element.id, trackId: track.id });
      }
    }
  }
  return points;
}

export const playheadSnapPoint = (time: number): SnapPoint => ({ time, type: "playhead" });

export function bookmarkSnapPoints(bookmarks: ReadonlyArray<Bookmark>, exceptTime?: number): SnapPoint[] {
  return bookmarks.filter((b) => b.time !== exceptTime).map((b) => ({ time: b.time, type: "bookmark" as const }));
}

/** Nearest point within `maxDistance`; ties go to the earlier point in the list. */
export function resolveSnap(input: { target: number; points: ReadonlyArray<SnapPoint>; maxDistance: number }): SnapResult {
  let best: SnapPoint | null = null;
  let bestDistance = Infinity;
  for (const point of input.points) {
    const d = Math.abs(point.time - input.target);
    if (d <= input.maxDistance && d < bestDistance) {
      best = point;
      bestDistance = d;
    }
  }
  return best
    ? { snappedTime: best.time, snapPoint: best, distance: bestDistance }
    : { snappedTime: input.target, snapPoint: null, distance: 0 };
}

export interface SnapGroupMember {
  /** Member start relative to the anchor start. */
  offset: number;
  duration: number;
}

/** Snap the anchor start so that any member edge lands on the closest point. */
export function snapGroupEdges(input: {
  anchorStart: number; members: ReadonlyArray<SnapGroupMember>; points: ReadonlyArray<SnapPoint>; maxDistance: number;
}): { anchorStart: number; snapPoint: SnapPoint | null } {
  let best: { anchorStart: number; snapPoint: SnapPoint; distance: number } | null = null;
  for (const member of input.members) {
    const start = input.anchorStart + member.offset;
    const end = start + member.duration;
    const hitStart = resolveSnap({ target: start, points: input.points, maxDistance: input.maxDistance });
    const hitEnd = resolveSnap({ target: end, points: input.points, maxDistance: input.maxDistance });
    if (hitStart.snapPoint && (!best || hitStart.distance < best.distance)) {
      best = { anchorStart: roundMediaTime(hitStart.snappedTime - member.offset), snapPoint: hitStart.snapPoint, distance: hitStart.distance };
    }
    if (hitEnd.snapPoint && (!best || hitEnd.distance < best.distance)) {
      best = { anchorStart: roundMediaTime(hitEnd.snappedTime - member.offset - member.duration), snapPoint: hitEnd.snapPoint, distance: hitEnd.distance };
    }
  }
  return best ? { anchorStart: best.anchorStart, snapPoint: best.snapPoint } : { anchorStart: input.anchorStart, snapPoint: null };
}

/** Snap the dragged resize edge of the group to the closest point; returns the adjusted delta. */
export function snapResizeDelta(input: {
  edges: ReadonlyArray<number>; delta: number; points: ReadonlyArray<SnapPoint>; maxDistance: number;
}): { delta: number; snapPoint: SnapPoint | null } {
  let best: { delta: number; snapPoint: SnapPoint; distance: number } | null = null;
  for (const edge of input.edges) {
    const hit = resolveSnap({ target: edge + input.delta, points: input.points, maxDistance: input.maxDistance });
    if (hit.snapPoint && (!best || hit.distance < best.distance)) {
      best = { delta: hit.snappedTime - edge, snapPoint: hit.snapPoint, distance: hit.distance };
    }
  }
  return best ? { delta: best.delta, snapPoint: best.snapPoint } : { delta: input.delta, snapPoint: null };
}
