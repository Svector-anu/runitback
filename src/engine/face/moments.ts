import { frameSpans } from "#/engine/visual";
import { regionOf, type FaceRegion, type TimeSpan } from "./geometry";
import type { FaceBox, FaceDetections } from "./types";

export type FaceMomentSort = "time" | "longest";

export interface FaceQuery {
  /** true (default): frames with faces; false: frames where no face qualifies. */
  present?: boolean;
  /** Fewest qualifying faces in a frame (present moments only). */
  minFaces?: number;
  /** Most qualifying faces in a frame (present moments only). */
  maxFaces?: number;
  /** Smallest face height as a fraction of the frame height; smaller faces do not qualify. */
  minSize?: number;
  /** Only faces whose centre is in this third of the frame qualify. */
  region?: FaceRegion;
  /** Drop moments shorter than this. */
  minDurationSeconds?: number;
  /** Restrict to this source range; moments are clipped to it. */
  sourceRange?: TimeSpan;
  sort?: FaceMomentSort;
  limit?: number;
}

export interface FaceMoment extends TimeSpan {
  /** Sampled frames that make up the moment. */
  frames: number;
  /** Most qualifying faces in one frame. */
  maxFaces: number;
  meanFaces: number;
  /** Tallest qualifying face as a fraction of frame height (0 for absent moments). */
  largestSize: number;
}

const EPSILON = 1e-6;
export const DEFAULT_FACE_MOMENT_LIMIT = 10;

/** The faces of a frame that satisfy the size and region parts of a query. */
export function qualifyingFaces(boxes: ReadonlyArray<FaceBox>, query: Pick<FaceQuery, "minSize" | "region">): FaceBox[] {
  return boxes.filter((box) => (query.minSize === undefined || box.height >= query.minSize) && (query.region === undefined || regionOf(box) === query.region));
}

function frameMatches(count: number, query: FaceQuery): boolean {
  if (query.present === false) return count === 0;
  return count >= Math.max(1, query.minFaces ?? 1) && (query.maxFaces === undefined || count <= query.maxFaces);
}

/**
 * Stretches of source time where the sampled frames satisfy the query. Each frame stands for the span halfway to its
 * neighbours (never across a scene cut in `cuts`); touching matching spans merge, so the edges are as precise as the
 * sampling. The longest continuous presence is `sort: "longest"` with `limit: 1`. Deterministic: ties go to earlier time.
 */
export function findFaceMoments(input: { detections: FaceDetections; query?: FaceQuery; cuts?: ReadonlyArray<number> }): FaceMoment[] {
  const { detections } = input;
  const query = input.query ?? {};
  const spans = frameSpans({ times: detections.frames.map((f) => f.t), durationSeconds: detections.durationSeconds, cuts: input.cuts ?? [] });
  const moments: FaceMoment[] = [];
  let total = 0;
  detections.frames.forEach((frame, i) => {
    const span = spans[i];
    if (!span) return;
    const range = query.sourceRange;
    const startSeconds = Math.max(span.startSeconds, range?.startSeconds ?? 0);
    const endSeconds = Math.min(span.endSeconds, range?.endSeconds ?? Number.POSITIVE_INFINITY);
    if (endSeconds - startSeconds <= EPSILON) return;
    const qualifying = qualifyingFaces(frame.boxes, query);
    if (!frameMatches(qualifying.length, query)) return;
    const largest = qualifying.reduce((m, b) => Math.max(m, b.height), 0);
    const last = moments[moments.length - 1];
    if (last && startSeconds - last.endSeconds <= EPSILON) {
      total += qualifying.length;
      last.endSeconds = endSeconds;
      last.frames += 1;
      last.maxFaces = Math.max(last.maxFaces, qualifying.length);
      last.largestSize = Math.max(last.largestSize, largest);
      last.meanFaces = total / last.frames;
    } else {
      total = qualifying.length;
      moments.push({ startSeconds, endSeconds, frames: 1, maxFaces: qualifying.length, meanFaces: qualifying.length, largestSize: largest });
    }
  });

  const minDuration = query.minDurationSeconds ?? 0;
  const kept = moments.filter((m) => m.endSeconds - m.startSeconds >= minDuration - EPSILON);
  const ordered = query.sort === "longest"
    ? [...kept].sort((a, b) => (b.endSeconds - b.startSeconds) - (a.endSeconds - a.startSeconds) || a.startSeconds - b.startSeconds)
    : kept;
  return ordered.slice(0, query.limit ?? DEFAULT_FACE_MOMENT_LIMIT);
}
