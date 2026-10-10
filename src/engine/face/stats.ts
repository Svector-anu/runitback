import { FACE_REGIONS, boxArea, regionOf, type FaceRegion, type TimeSpan } from "./geometry";
import type { FaceBox, FaceDetections } from "./types";

export interface FaceShotStats {
  /** Sampled frames that fall inside the shot. */
  framesSampled: number;
  /** Share of those frames with at least one face, 0..1; 0 when nothing was sampled. */
  presentRatio: number;
  /** Mean number of faces per sampled frame. */
  meanCount: number;
  /** The biggest face seen in the shot, with the source time of its frame. */
  largest?: { t: number; box: FaceBox };
  /** The third of the frame most faces sit in, weighted by face area. */
  dominantPosition?: FaceRegion;
}

const round3 = (value: number): number => Math.round(value * 1000) / 1000;

/** Sampled-frame statistics for each span (shot). A frame belongs to the span that contains its time; the last span includes its end. */
export function faceShotStats(input: { detections: FaceDetections; spans: ReadonlyArray<TimeSpan> }): FaceShotStats[] {
  const { detections, spans } = input;
  return spans.map((span, index) => {
    const last = index === spans.length - 1;
    const frames = detections.frames.filter((f) => f.t >= span.startSeconds && (f.t < span.endSeconds || (last && f.t <= span.endSeconds)));
    const withFaces = frames.filter((f) => f.boxes.length > 0).length;
    const weight: Record<FaceRegion, number> = { left: 0, center: 0, right: 0 };
    let largest: FaceShotStats["largest"];
    let count = 0;
    for (const frame of frames) {
      for (const box of frame.boxes) {
        count += 1;
        weight[regionOf(box)] += boxArea(box);
        if (!largest || boxArea(box) > boxArea(largest.box)) largest = { t: frame.t, box };
      }
    }
    const dominant = FACE_REGIONS.reduce<FaceRegion | undefined>((best, region) => (weight[region] > (best ? weight[best] : 0) ? region : best), undefined);
    return {
      framesSampled: frames.length,
      presentRatio: frames.length > 0 ? round3(withFaces / frames.length) : 0,
      meanCount: frames.length > 0 ? round3(count / frames.length) : 0,
      ...(largest ? { largest } : {}),
      ...(dominant ? { dominantPosition: dominant } : {}),
    };
  });
}
