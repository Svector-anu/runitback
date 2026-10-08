import { mediaTime, type MediaTime } from "#/engine/time";
import {
  orderedTracks, type AudioTrack, type ElementRef, type OverlayTrack, type SceneTracks, type TimelineElement,
  type TimelineTrack,
} from "#/engine/model";

export interface LocatedElement {
  track: TimelineTrack;
  element: TimelineElement;
  ref: ElementRef;
}

export const elementEnd = (element: { startTime: number; duration: number }): number => element.startTime + element.duration;

export function findTrack(tracks: SceneTracks, trackId: string): TimelineTrack | undefined {
  return orderedTracks(tracks).find((t) => t.id === trackId);
}

export function displayIndexOfTrack(tracks: SceneTracks, trackId: string): number {
  return orderedTracks(tracks).findIndex((t) => t.id === trackId);
}

export function getElement(tracks: SceneTracks, ref: ElementRef): TimelineElement | undefined {
  const track = findTrack(tracks, ref.trackId);
  return (track?.elements as TimelineElement[] | undefined)?.find((e) => e.id === ref.elementId);
}

export function allElements(tracks: SceneTracks): LocatedElement[] {
  const out: LocatedElement[] = [];
  for (const track of orderedTracks(tracks)) {
    for (const element of track.elements as TimelineElement[]) {
      out.push({ track, element, ref: { trackId: track.id, elementId: element.id } });
    }
  }
  return out;
}

export function totalDuration(tracks: SceneTracks): MediaTime {
  let max = 0;
  for (const track of orderedTracks(tracks)) {
    for (const element of track.elements) max = Math.max(max, elementEnd(element));
  }
  return mediaTime(max);
}

/** Elements whose span strictly contains `time` (used by split-at-playhead). */
export function elementsStrictlyAt(tracks: SceneTracks, time: number): LocatedElement[] {
  return allElements(tracks).filter(({ element }) => element.startTime < time && time < elementEnd(element));
}

/** Elements visible at `time` (start inclusive, end exclusive). */
export function elementsActiveAt(tracks: SceneTracks, time: number): LocatedElement[] {
  return allElements(tracks).filter(({ element }) => element.startTime <= time && time < elementEnd(element));
}

/** Replace a track's element list while keeping its concrete track type. */
export function withElements<T extends TimelineTrack>(track: T, elements: ReadonlyArray<TimelineElement>): T {
  return { ...track, elements } as T;
}

export function mapTracks(tracks: SceneTracks, fn: <T extends TimelineTrack>(track: T) => T): SceneTracks {
  return {
    overlay: tracks.overlay.map((t) => fn(t)),
    main: fn(tracks.main),
    audio: tracks.audio.map((t) => fn(t)),
  };
}

export function mapElements(tracks: SceneTracks, fn: (element: TimelineElement, track: TimelineTrack) => TimelineElement): SceneTracks {
  return mapTracks(tracks, (track) => withElements(track, (track.elements as TimelineElement[]).map((e) => fn(e, track))));
}

export function replaceElement(tracks: SceneTracks, ref: ElementRef, next: TimelineElement): SceneTracks {
  return mapTracks(tracks, (track) =>
    track.id === ref.trackId
      ? withElements(track, (track.elements as TimelineElement[]).map((e) => (e.id === ref.elementId ? next : e)))
      : track);
}

export function removeElements(tracks: SceneTracks, refs: ReadonlyArray<ElementRef>): SceneTracks {
  const doomed = new Set(refs.map((r) => `${r.trackId}/${r.elementId}`));
  return mapTracks(tracks, (track) =>
    withElements(track, (track.elements as TimelineElement[]).filter((e) => !doomed.has(`${track.id}/${e.id}`))));
}

/** Overlay and audio tracks with no elements are removed; the main track is permanent. */
export function pruneEmptyTracks(tracks: SceneTracks): SceneTracks {
  const overlay = tracks.overlay.filter((t) => t.elements.length > 0);
  const audio = tracks.audio.filter((t) => t.elements.length > 0);
  if (overlay.length === tracks.overlay.length && audio.length === tracks.audio.length) return tracks;
  return { ...tracks, overlay, audio };
}

export function removeTrack(tracks: SceneTracks, trackId: string): SceneTracks {
  return {
    ...tracks,
    overlay: tracks.overlay.filter((t) => t.id !== trackId),
    audio: tracks.audio.filter((t) => t.id !== trackId),
  };
}

/** Insert at a display index across `[...overlay, main, ...audio]`. Overlay types never go below main. */
export function insertTrack(tracks: SceneTracks, track: TimelineTrack, displayIndex: number): SceneTracks {
  const overlayCount = tracks.overlay.length;
  if (track.type === "audio") {
    const at = Math.min(Math.max(0, displayIndex - overlayCount - 1), tracks.audio.length);
    const audio = [...tracks.audio];
    audio.splice(at, 0, track as AudioTrack);
    return { ...tracks, audio };
  }
  const at = Math.min(Math.max(0, displayIndex), overlayCount);
  const overlay = [...tracks.overlay];
  overlay.splice(at, 0, track as OverlayTrack);
  return { ...tracks, overlay };
}

export function intervalsOverlap(a: { start: number; end: number }, b: { start: number; end: number }): boolean {
  return a.start < b.end && a.end > b.start;
}
