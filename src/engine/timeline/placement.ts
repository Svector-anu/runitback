import { mediaTime, type MediaTime } from "#/engine/time";
import {
  TRACK_TYPE_FOR_ELEMENT, orderedTracks, mainTrackIndex, type ElementType, type SceneTracks, type TimelineElement,
  type TimelineTrack, type TrackType,
} from "#/engine/model";
import { elementEnd, insertTrack, intervalsOverlap, mapTracks, withElements } from "./tracks";

export interface TimeSpan {
  start: number;
  duration: number;
  /** An element that is being moved and must not collide with itself. */
  excludeElementId?: string;
}

export type InsertDirection = "above" | "below";

export type PlacementStrategy =
  | { kind: "explicit"; trackId: string }
  | { kind: "firstAvailable" }
  | { kind: "preferIndex"; trackIndex: number; hoverDirection: InsertDirection; verticalDragDirection?: "up" | "down" | null; createNewTrackOnly?: boolean }
  | { kind: "aboveSource"; sourceTrackIndex: number }
  | { kind: "alwaysNew"; position: "highest" | "default" };

export type PlacementResult =
  | { kind: "existingTrack"; trackId: string; trackIndex: number; trackType: TrackType; adjustedStartTime?: MediaTime }
  | { kind: "newTrack"; trackType: TrackType; insertIndex: number; insertPosition: InsertDirection | null };

export function trackTypeForElement(type: ElementType): TrackType {
  return TRACK_TYPE_FOR_ELEMENT[type];
}

export function canPlaceSpans(track: TimelineTrack, spans: ReadonlyArray<TimeSpan>): boolean {
  return spans.every((span) => {
    const a = { start: span.start, end: span.start + span.duration };
    return !(track.elements as TimelineElement[]).some(
      (e) => e.id !== span.excludeElementId && intervalsOverlap(a, { start: e.startTime, end: elementEnd(e) }),
    );
  });
}

/** Display index where a new track of `type` goes by default (next to the content of its kind). */
export function defaultInsertIndex(tracks: SceneTracks, type: TrackType): number {
  if (type === "audio") return tracks.overlay.length + 1 + tracks.audio.length;
  if (type === "effect") return 0;
  return tracks.overlay.length;
}

/** Display index for the topmost slot of a type: top of the stack, or directly beneath main for audio. */
export function highestInsertIndex(tracks: SceneTracks, type: TrackType): number {
  return type === "audio" ? tracks.overlay.length + 1 : 0;
}

/** A clip that would start at or before the earliest other main-track clip is pinned to t=0. */
export function enforceMainTrackStart(input: {
  tracks: SceneTracks; trackId: string; requestedStart: number; excludeElementId?: string;
}): MediaTime {
  const { tracks } = input;
  if (tracks.main.id !== input.trackId) return mediaTime(input.requestedStart);
  const others = tracks.main.elements.filter((e) => e.id !== input.excludeElementId);
  if (others.length === 0) return mediaTime(0);
  const earliest = Math.min(...others.map((e) => e.startTime));
  return mediaTime(input.requestedStart <= earliest ? 0 : input.requestedStart);
}

function newTrackNear(input: {
  tracks: SceneTracks; trackType: TrackType; preferredIndex: number; direction: InsertDirection;
}): Extract<PlacementResult, { kind: "newTrack" }> {
  const { tracks, trackType, direction } = input;
  const count = orderedTracks(tracks).length;
  const preferred = Math.min(Math.max(0, input.preferredIndex), count - 1);
  const mainIdx = mainTrackIndex(tracks);

  if (trackType === "audio") {
    if (preferred <= mainIdx) return { kind: "newTrack", trackType, insertIndex: mainIdx + 1, insertPosition: "below" };
    return { kind: "newTrack", trackType, insertIndex: direction === "above" ? preferred : preferred + 1, insertPosition: direction };
  }
  const insertIndex = direction === "above" ? preferred : preferred + 1;
  if (insertIndex > mainIdx) return { kind: "newTrack", trackType, insertIndex: mainIdx, insertPosition: "above" };
  return { kind: "newTrack", trackType, insertIndex, insertPosition: direction };
}

function existing(tracks: SceneTracks, track: TimelineTrack, spans: ReadonlyArray<TimeSpan>): PlacementResult {
  const trackIndex = orderedTracks(tracks).findIndex((t) => t.id === track.id);
  const first = spans[0];
  const result: PlacementResult = { kind: "existingTrack", trackId: track.id, trackIndex, trackType: track.type };
  if (track.id === tracks.main.id && first) {
    const adjusted = enforceMainTrackStart({ tracks, trackId: track.id, requestedStart: first.start, excludeElementId: first.excludeElementId });
    if (adjusted !== first.start) result.adjustedStartTime = adjusted;
  }
  return result;
}

export function resolveTrackPlacement(input: {
  tracks: SceneTracks;
  elementType?: ElementType;
  trackType?: TrackType;
  spans: ReadonlyArray<TimeSpan>;
  strategy: PlacementStrategy;
}): PlacementResult | null {
  const { tracks, spans, strategy } = input;
  const trackType = input.trackType ?? (input.elementType ? trackTypeForElement(input.elementType) : undefined);
  if (!trackType) return null;
  const ordered = orderedTracks(tracks);

  switch (strategy.kind) {
    case "explicit": {
      const track = ordered.find((t) => t.id === strategy.trackId);
      if (!track || track.type !== trackType) return null;
      const placed = existing(tracks, track, spans);
      const first = spans[0];
      const checked = first && placed.kind === "existingTrack" && placed.adjustedStartTime !== undefined
        ? [{ ...first, start: placed.adjustedStartTime }, ...spans.slice(1)]
        : spans;
      return canPlaceSpans(track, checked) ? placed : null;
    }
    case "firstAvailable": {
      const track = ordered.find((t) => t.type === trackType && canPlaceSpans(t, spans));
      if (track) return existing(tracks, track, spans);
      return { kind: "newTrack", trackType, insertIndex: highestInsertIndex(tracks, trackType), insertPosition: null };
    }
    case "preferIndex": {
      const preferred = ordered[Math.min(Math.max(0, strategy.trackIndex), ordered.length - 1)];
      const compatible = preferred?.type === trackType;
      if (preferred && !strategy.createNewTrackOnly && compatible && canPlaceSpans(preferred, spans)) {
        return existing(tracks, preferred, spans);
      }
      let direction = strategy.hoverDirection;
      if (!compatible && strategy.verticalDragDirection) direction = strategy.verticalDragDirection === "up" ? "above" : "below";
      return newTrackNear({ tracks, trackType, preferredIndex: strategy.trackIndex, direction });
    }
    case "aboveSource": {
      const above = ordered[strategy.sourceTrackIndex - 1];
      if (above && above.type === trackType && canPlaceSpans(above, spans)) return existing(tracks, above, spans);
      const any = ordered.find((t) => t.type === trackType && canPlaceSpans(t, spans));
      if (any) return existing(tracks, any, spans);
      return { kind: "newTrack", trackType, insertIndex: highestInsertIndex(tracks, trackType), insertPosition: null };
    }
    case "alwaysNew": {
      const insertIndex = strategy.position === "highest" ? highestInsertIndex(tracks, trackType) : defaultInsertIndex(tracks, trackType);
      return { kind: "newTrack", trackType, insertIndex, insertPosition: null };
    }
  }
}

/** Appends `elements` to the placement target, creating the track (with `newTrack`) when required. */
export function applyPlacement(input: {
  tracks: SceneTracks; placement: PlacementResult; elements: ReadonlyArray<TimelineElement>; newTrack?: TimelineTrack;
}): SceneTracks {
  const { tracks, placement, elements } = input;
  if (placement.kind === "existingTrack") {
    return mapTracks(tracks, (track) =>
      track.id === placement.trackId ? withElements(track, [...(track.elements as TimelineElement[]), ...elements]) : track);
  }
  if (!input.newTrack) throw new Error("applyPlacement: newTrack is required for a new-track placement");
  return insertTrack(tracks, withElements(input.newTrack, elements), placement.insertIndex);
}
