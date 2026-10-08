import type {
  ElementType, MediaType, SceneTracks, TimelineElement, TimelineTrack, TrackType, VisualElement,
} from "./types";

export const TRACK_TYPE_FOR_ELEMENT: Record<ElementType, TrackType> = {
  video: "video",
  image: "video",
  audio: "audio",
  text: "text",
  graphic: "graphic",
  effect: "effect",
};

export const MASKABLE_TYPES: readonly ElementType[] = ["video", "image", "graphic"];
export const RETIMABLE_TYPES: readonly ElementType[] = ["video", "audio"];
export const VISUAL_TYPES: readonly ElementType[] = ["video", "image", "text", "graphic"];

export function isVisualElement(element: TimelineElement): element is VisualElement {
  return VISUAL_TYPES.includes(element.type);
}
export function isMaskable(element: TimelineElement): boolean {
  return MASKABLE_TYPES.includes(element.type);
}
export function isRetimable(element: TimelineElement): boolean {
  return RETIMABLE_TYPES.includes(element.type);
}
export function canElementHaveAudio(element: TimelineElement): boolean {
  return element.type === "video" || element.type === "audio";
}
export function canTrackHaveAudio(track: TimelineTrack): boolean {
  return track.type === "video" || track.type === "audio";
}
export function canTrackBeHidden(track: TimelineTrack): boolean {
  return track.type !== "audio";
}
export function trackTypeForMedia(type: MediaType): TrackType {
  return type === "audio" ? "audio" : "video";
}

/** Display order top to bottom. */
export function orderedTracks(tracks: SceneTracks): TimelineTrack[] {
  return [...tracks.overlay, tracks.main, ...tracks.audio];
}

export function mainTrackIndex(tracks: SceneTracks): number {
  return tracks.overlay.length;
}
