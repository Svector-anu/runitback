import type { FrameSpan, ScoredFrame, VisualMoment } from "./types";

const EPSILON = 1e-6;

/** Shot boundaries 0, cuts..., duration; cuts outside (0, duration) are ignored. */
export function shotBounds(input: { durationSeconds: number; cuts: ReadonlyArray<number> }): number[] {
  const cuts = [...new Set(input.cuts)].filter((c) => c > 0 && c < input.durationSeconds).sort((a, b) => a - b);
  return [0, ...cuts, input.durationSeconds];
}

/**
 * The stretch of source time each sampled frame stands for: halfway to its neighbours on both sides, never beyond the
 * start or end of the asset and never across a scene cut (a frame says nothing about the shot next to its own).
 */
export function frameSpans(input: { times: ReadonlyArray<number>; durationSeconds: number; cuts: ReadonlyArray<number> }): FrameSpan[] {
  const { times, durationSeconds } = input;
  const bounds = shotBounds(input);
  return times.map((t, i) => {
    const previous = times[i - 1];
    const next = times[i + 1];
    let startSeconds = previous === undefined ? 0 : (previous + t) / 2;
    let endSeconds = next === undefined ? durationSeconds : (t + next) / 2;
    const shot = bounds.findIndex((bound, b) => t >= bound && t < (bounds[b + 1] ?? Infinity));
    const shotStart = bounds[Math.max(0, shot)] ?? 0;
    const shotEnd = bounds[shot + 1] ?? durationSeconds;
    startSeconds = Math.max(startSeconds, shotStart);
    endSeconds = Math.min(endSeconds, shotEnd);
    return { startSeconds, endSeconds: Math.max(startSeconds, endSeconds) };
  });
}

/**
 * Merges matching frames whose spans touch into moments, so five hits in a row become one stretch rather than five
 * clips. `mergeGapSeconds` bridges small holes between matches (default 0: only touching spans merge).
 */
export function mergeHitsIntoMoments(input: { spans: ReadonlyArray<FrameSpan>; hits: ReadonlyArray<ScoredFrame>; mergeGapSeconds?: number }): VisualMoment[] {
  const gap = input.mergeGapSeconds ?? 0;
  const ordered = input.hits
    .flatMap((hit) => {
      const span = input.spans[hit.index];
      return span && span.endSeconds - span.startSeconds > EPSILON ? [{ span, score: hit.score }] : [];
    })
    .sort((a, b) => a.span.startSeconds - b.span.startSeconds);
  const moments: VisualMoment[] = [];
  for (const { span, score } of ordered) {
    const last = moments[moments.length - 1];
    if (last && span.startSeconds - last.endSeconds <= gap + EPSILON) {
      last.endSeconds = Math.max(last.endSeconds, span.endSeconds);
      last.score = Math.max(last.score, score);
      last.frames += 1;
    } else {
      moments.push({ startSeconds: span.startSeconds, endSeconds: span.endSeconds, score, frames: 1 });
    }
  }
  return moments;
}

export type VisualMomentSort = "relevance" | "time";

/** Best score first (ties by time), or chronological. */
export function sortVisualMoments<T extends VisualMoment>(moments: ReadonlyArray<T>, sort: VisualMomentSort): T[] {
  return [...moments].sort((a, b) => (sort === "time" ? 0 : b.score - a.score) || a.startSeconds - b.startSeconds);
}
