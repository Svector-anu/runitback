import { clamp, createRng, mean, quantileSorted, shuffle } from "./stats";
import type { CutPlan, PlannedShot, SourceRange, StyleProfile } from "./types";
import { QUANTILE_LEVELS } from "./profile";

/** Beat snapping only happens when the reference cut to the beat at least this often. */
export const BEAT_SNAP_MIN_SCORE = 0.5;
const SNAP_WINDOW_FRACTION = 0.3;
const EPSILON = 1e-9;
const STRATA_FOR_MEAN = 64;

export interface PlanCutsInput {
  sourceRanges: ReadonlyArray<SourceRange>;
  profile: StyleProfile;
  /** Beat times on the timeline (plan starts at 0), ascending. */
  beats?: ReadonlyArray<number>;
  minShot: number;
  maxShot: number;
  seed: number;
  /** Seconds of output wanted. Defaults to, and is capped at, the usable source length. */
  targetDuration?: number;
}

function lengthAt(quantiles: ReadonlyArray<number>, u: number): number {
  return quantileSorted(quantiles, u);
}

/** One block of shot lengths covering u in (0,1) with one jittered draw per stratum, in random order. */
function stratifiedBlock(input: { quantiles: ReadonlyArray<number>; size: number; min: number; max: number; rng: () => number }): number[] {
  const lengths: number[] = [];
  for (let i = 0; i < input.size; i++) {
    lengths.push(clamp(lengthAt(input.quantiles, (i + input.rng()) / input.size), input.min, input.max));
  }
  return shuffle(lengths, input.rng);
}

function nearestBeat(input: { beats: ReadonlyArray<number>; low: number; high: number; ideal: number }): number | undefined {
  let best: number | undefined;
  for (const beat of input.beats) {
    if (beat < input.low - EPSILON) continue;
    if (beat > input.high + EPSILON) break;
    if (best === undefined || Math.abs(beat - input.ideal) < Math.abs(best - input.ideal) - EPSILON) best = beat;
  }
  return best;
}

/** Shot durations whose distribution follows the profile, cut points snapped to beats when allowed. */
function planDurations(input: PlanCutsInput & { target: number }): { durations: number[]; snapped: number; snapping: boolean } {
  const { profile, minShot, maxShot, target } = input;
  const rng = createRng(input.seed);
  const quantiles = profile.shots.quantiles.length > 1 ? profile.shots.quantiles : QUANTILE_LEVELS.map(() => profile.shots.meanSeconds);
  const expected = mean(Array.from({ length: STRATA_FOR_MEAN }, (_, i) => clamp(lengthAt(quantiles, (i + 0.5) / STRATA_FOR_MEAN), minShot, maxShot)));
  const blockSize = Math.max(1, Math.round(target / expected));
  const beats = input.beats ?? [];
  const snapping = beats.length > 0 && profile.beatLock.beatsAvailable && profile.beatLock.score >= BEAT_SNAP_MIN_SCORE;

  const durations: number[] = [];
  let cursor = 0;
  let snapped = 0;
  let pool: number[] = [];
  while (target - cursor > EPSILON) {
    if (pool.length === 0) pool = stratifiedBlock({ quantiles, size: blockSize, min: minShot, max: maxShot, rng });
    let length = pool.pop() as number;
    const remaining = target - cursor;
    if (length >= remaining - EPSILON) {
      length = remaining;
    } else if (remaining - length < minShot) {
      if (remaining <= maxShot) length = remaining;
      else if (remaining - minShot >= minShot) length = remaining - minShot;
      else break;
    }
    const isFinal = Math.abs(length - remaining) <= EPSILON;
    if (snapping && !isFinal) {
      const reach = length * SNAP_WINDOW_FRACTION;
      const beat = nearestBeat({ beats, low: Math.max(cursor + minShot, cursor + length - reach), high: Math.min(cursor + maxShot, cursor + length + reach), ideal: cursor + length });
      if (beat !== undefined && (target - beat < EPSILON || target - beat >= minShot - EPSILON)) {
        length = beat - cursor;
        snapped++;
      }
    }
    durations.push(length);
    cursor += length;
  }
  return { durations, snapped, snapping };
}

interface Remaining { assetId: string; cursor: number; end: number }

/**
 * Proposes an ordered shot list whose length distribution follows `profile.shots.quantiles` (stratified inverse-CDF
 * sampling, so the empirical distribution tracks the target closely even for short outputs). When the reference cut to
 * the beat (`beatLock.score >= 0.5`) and `beats` are given, each cut moves to the nearest beat inside a window of
 * 30% of the shot length that keeps min/max respected. Source material is consumed forward, never reused or overrun.
 * Deterministic for a given input and seed.
 */
export function planCutsToProfile(input: PlanCutsInput): CutPlan {
  if (!(input.minShot > 0) || input.maxShot < input.minShot) throw new RangeError("planCutsToProfile needs 0 < minShot <= maxShot.");
  const notes: string[] = [];
  const ranges: Remaining[] = input.sourceRanges
    .filter((r) => r.end - r.start >= input.minShot - EPSILON)
    .map((r) => ({ assetId: r.assetId, cursor: r.start, end: r.end }));
  const usable = ranges.reduce((n, r) => n + (r.end - r.cursor), 0);
  if (ranges.length < input.sourceRanges.length) notes.push(`Ignored ${input.sourceRanges.length - ranges.length} source range(s) shorter than minShot.`);
  if (usable < input.minShot) return { shots: [], totalSeconds: 0, beatSnapped: false, snappedCuts: 0, notes: [...notes, "No source range is long enough for one shot."] };

  const wanted = input.targetDuration ?? usable;
  const target = Math.min(wanted, usable);
  if (wanted > usable + EPSILON) notes.push(`Target ${wanted}s exceeds usable source (${usable}s); planned ${usable}s.`);
  if (target < input.minShot) return { shots: [], totalSeconds: 0, beatSnapped: false, snappedCuts: 0, notes: [...notes, "Target duration is shorter than minShot."] };

  const { durations, snapped, snapping } = planDurations({ ...input, target });
  const rng = createRng(input.seed ^ 0x9e3779b9);
  const shots: PlannedShot[] = [];
  let timeline = 0;
  for (const wantedLength of durations) {
    const fitting = ranges.filter((r) => r.end - r.cursor >= wantedLength - EPSILON);
    let length = wantedLength;
    let pick: Remaining | undefined;
    if (fitting.length > 0) {
      pick = fitting[Math.floor(rng() * fitting.length)];
    } else {
      pick = ranges.reduce<Remaining | undefined>((best, r) => (!best || r.end - r.cursor > best.end - best.cursor ? r : best), undefined);
      length = pick ? pick.end - pick.cursor : 0;
      if (length < input.minShot - EPSILON) {
        notes.push("Source ran out (fragmented ranges); the plan ends early.");
        break;
      }
    }
    if (!pick) break;
    const inPoint = pick.cursor;
    const outPoint = Math.min(pick.end, inPoint + length);
    pick.cursor = outPoint;
    shots.push({ assetId: pick.assetId, in: inPoint, out: outPoint, start: timeline, duration: outPoint - inPoint });
    timeline += outPoint - inPoint;
  }
  const beatSnapped = snapping && snapped > 0;
  if (!snapping && (input.beats?.length ?? 0) > 0 && input.profile.beatLock.score < BEAT_SNAP_MIN_SCORE) notes.push("The reference does not cut to the beat, so cuts were not snapped.");
  return { shots, totalSeconds: timeline, beatSnapped, snappedCuts: snapped, notes };
}
