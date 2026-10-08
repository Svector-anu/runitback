import { mediaTime, type MediaTime } from "#/engine/time";
import type { ElementType, SceneTracks, TimelineElement } from "#/engine/model";
import { orderedTracks } from "#/engine/model";
import { resolveTrackPlacement, type InsertDirection, type TimeSpan } from "./placement";
import { elementEnd } from "./tracks";

export interface TrackLayout {
  heights: ReadonlyArray<number>;
  gap: number;
}

export interface DropTarget {
  /** Display index of the target track, or the insertion index when `isNewTrack`. */
  trackIndex: number;
  isNewTrack: boolean;
  insertPosition: InsertDirection | null;
  xPosition: MediaTime;
  targetElement: { elementId: string; trackId: string } | null;
}

export type VerticalDirection = "up" | "down" | null;

export function trackTops(layout: TrackLayout): number[] {
  const tops: number[] = [];
  let y = 0;
  for (const h of layout.heights) {
    tops.push(y);
    y += h + layout.gap;
  }
  return tops;
}

export function getTrackAtY(input: { layout: TrackLayout; y: number; direction: VerticalDirection }): { index: number; relativeY: number } | null {
  const tops = trackTops(input.layout);
  const { heights, gap } = input.layout;
  for (let i = 0; i < heights.length; i++) {
    const top = tops[i] as number;
    const height = heights[i] as number;
    if (input.y >= top && input.y < top + height) return { index: i, relativeY: input.y - top };
    const nextTop = tops[i + 1];
    if (nextTop !== undefined && input.y >= top + height && input.y < nextTop) {
      const goUp = input.direction === "up" || (input.direction === null && input.y - (top + height) < gap / 2);
      return goUp ? { index: i, relativeY: height - 1 } : { index: i + 1, relativeY: 0 };
    }
  }
  return null;
}

export function dropLineY(input: { layout: TrackLayout; trackIndex: number }): number {
  const tops = trackTops(input.layout);
  const { heights, gap } = input.layout;
  if (input.trackIndex <= 0) return 0;
  if (input.trackIndex >= heights.length) {
    const last = heights.length - 1;
    return (tops[last] ?? 0) + (heights[last] ?? 0) + gap / 2;
  }
  return (tops[input.trackIndex] ?? 0) - gap / 2;
}

export function computeDropTarget(input: {
  tracks: SceneTracks;
  elementType: ElementType;
  mouseY: number;
  startTime: number;
  duration: number;
  layout: TrackLayout;
  verticalDirection: VerticalDirection;
  excludeElementId?: string;
  /** When set, hovering a clip of one of these types targets that clip instead of a track. */
  targetElementTypes?: ReadonlyArray<ElementType>;
}): DropTarget | null {
  const { tracks } = input;
  const ordered = orderedTracks(tracks);
  const spans: TimeSpan[] = [{ start: input.startTime, duration: input.duration, excludeElementId: input.excludeElementId }];
  const x = mediaTime(Math.max(0, input.startTime));

  const hit = getTrackAtY({ layout: input.layout, y: input.mouseY, direction: input.verticalDirection });
  const forced = hit === null;
  const trackIndex = hit ? hit.index : input.mouseY < 0 ? 0 : ordered.length - 1;
  const hover: InsertDirection = forced
    ? (input.mouseY < 0 ? "above" : "below")
    : hit.relativeY < (input.layout.heights[hit.index] ?? 0) / 2 ? "above" : "below";

  if (hit && input.targetElementTypes) {
    const track = ordered[hit.index];
    const under = (track?.elements as TimelineElement[] | undefined)?.find(
      (e) => e.startTime <= input.startTime && input.startTime < elementEnd(e) && input.targetElementTypes?.includes(e.type),
    );
    if (track && under) {
      return { trackIndex: hit.index, isNewTrack: false, insertPosition: null, xPosition: x, targetElement: { elementId: under.id, trackId: track.id } };
    }
  }

  const placement = resolveTrackPlacement({
    tracks, elementType: input.elementType, spans,
    strategy: { kind: "preferIndex", trackIndex, hoverDirection: hover, verticalDragDirection: input.verticalDirection, createNewTrackOnly: forced },
  });
  if (!placement) return null;
  if (placement.kind === "existingTrack") {
    return { trackIndex: placement.trackIndex, isNewTrack: false, insertPosition: null, xPosition: placement.adjustedStartTime ?? x, targetElement: null };
  }
  return { trackIndex: placement.insertIndex, isNewTrack: true, insertPosition: placement.insertPosition, xPosition: x, targetElement: null };
}
