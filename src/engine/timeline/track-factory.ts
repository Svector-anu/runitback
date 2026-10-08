import { createTrack, type TimelineTrack, type TrackType } from "#/engine/model";

export function createTrackOfType(type: TrackType, id: string): TimelineTrack {
  return createTrack(type, id);
}
