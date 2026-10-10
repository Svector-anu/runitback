import { iou } from "./geometry";
import type { FaceBox, FaceDetections } from "./types";

export interface TrackedFace extends FaceBox {
  /** Stable across frames: the same person keeps the id while the tracker can follow them. Starts at 1. */
  id: number;
}

export interface TrackedFrame {
  t: number;
  /** Boxes smoothed along their track, ascending by id. */
  faces: TrackedFace[];
}

export interface TrackOptions {
  /** Lowest overlap with a track's last box for a detection to continue it (default 0.2). */
  minIou?: number;
  /** Weight of the new box in the running average, 0 < x <= 1; 1 means no smoothing (default 0.6). */
  smoothing?: number;
  /** Frames a track may go unseen before it is dropped (default 1). */
  maxMissedFrames?: number;
}

export const DEFAULT_MIN_IOU = 0.2;
export const DEFAULT_SMOOTHING = 0.6;
export const DEFAULT_MAX_MISSED_FRAMES = 1;

interface Track {
  id: number;
  box: FaceBox;
  missed: number;
}

const blend = (previous: number, next: number, weight: number): number => previous + (next - previous) * weight;

/**
 * Follows faces through the sampled frames: each detection continues the track it overlaps most (greedy by IoU, ties
 * by older track), otherwise starts a new one. Boxes are smoothed with an exponential moving average along the track.
 * Deterministic and independent of box order within a frame.
 */
export function trackFaces(detections: FaceDetections, options: TrackOptions = {}): TrackedFrame[] {
  const minIou = options.minIou ?? DEFAULT_MIN_IOU;
  const weight = Math.min(1, Math.max(Number.EPSILON, options.smoothing ?? DEFAULT_SMOOTHING));
  const maxMissed = options.maxMissedFrames ?? DEFAULT_MAX_MISSED_FRAMES;
  let tracks: Track[] = [];
  let nextId = 1;

  return detections.frames.map((frame): TrackedFrame => {
    const pairs = tracks.flatMap((track) => frame.boxes.map((box, boxIndex) => ({ track, boxIndex, overlap: iou(track.box, box) })))
      .filter((pair) => pair.overlap >= minIou)
      .sort((a, b) => b.overlap - a.overlap || a.track.id - b.track.id || a.boxIndex - b.boxIndex);
    const usedTracks = new Set<number>();
    const usedBoxes = new Set<number>();
    const faces: TrackedFace[] = [];
    for (const { track, boxIndex } of pairs) {
      const box = frame.boxes[boxIndex];
      if (!box || usedTracks.has(track.id) || usedBoxes.has(boxIndex)) continue;
      usedTracks.add(track.id);
      usedBoxes.add(boxIndex);
      const smoothed: FaceBox = {
        x: blend(track.box.x, box.x, weight), y: blend(track.box.y, box.y, weight),
        width: blend(track.box.width, box.width, weight), height: blend(track.box.height, box.height, weight), score: box.score,
      };
      track.box = smoothed;
      track.missed = 0;
      faces.push({ ...smoothed, id: track.id });
    }
    frame.boxes.forEach((box, boxIndex) => {
      if (usedBoxes.has(boxIndex)) return;
      const track: Track = { id: nextId++, box: { ...box }, missed: 0 };
      tracks.push(track);
      usedTracks.add(track.id);
      faces.push({ ...box, id: track.id });
    });
    for (const track of tracks) if (!usedTracks.has(track.id)) track.missed += 1;
    tracks = tracks.filter((track) => track.missed <= maxMissed);
    return { t: frame.t, faces: faces.sort((a, b) => a.id - b.id) };
  });
}
