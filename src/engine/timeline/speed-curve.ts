import { RETIME_MAX, RETIME_MIN, SPEED_CURVE_MAX_POINTS, clampRate, type SpeedCurve, type SpeedCurvePoint } from "#/engine/model";

/**
 * Speed-curve maths. The curve is the rate r(s) as a function of source position s (ticks), piecewise linear and flat
 * outside its end points. Everything derives from the cumulative timeline time T(s) = integral of ds / r(s):
 *
 *   timeline time to play source [a, b]  = T(b) - T(a)
 *   source position after t from s0      = T^-1(T(s0) + t)
 *
 * On a segment where r goes linearly from ra to rb the integral is closed-form, (b - a) / (rb - ra) * ln(rb / ra), and
 * the inverse is exponential in time (r = ra * e^(g t) with g = dr/ds), so mapping and its inverse are exact, not
 * numerically integrated. Clip trims, splits and resizes only move the window [trimStart, trimStart + visible] along
 * the same curve, which is why split halves rejoin to the original mapping.
 */

const FLAT = 1e-9;

interface Prepared {
  points: SpeedCurvePoint[];
  ats: number[];
  /** cumulative[k] = T(points[k].at) - T(points[0].at). */
  cumulative: number[];
}

const preparedCache = new WeakMap<SpeedCurve, Prepared>();

/** Timeline ticks to play [a, b] while the rate goes linearly from ra to rb. */
function segmentTime(a: number, b: number, ra: number, rb: number): number {
  const length = b - a;
  if (Math.abs(rb - ra) <= FLAT * Math.max(ra, rb)) return length / ra;
  return (length / (rb - ra)) * Math.log(rb / ra);
}

function prepare(curve: SpeedCurve): Prepared {
  const cached = preparedCache.get(curve);
  if (cached) return cached;
  const points = curve.points;
  const cumulative = [0];
  for (let k = 0; k + 1 < points.length; k++) {
    const a = points[k] as SpeedCurvePoint, b = points[k + 1] as SpeedCurvePoint;
    cumulative.push((cumulative[k] as number) + segmentTime(a.at, b.at, a.rate, b.rate));
  }
  const prepared = { points, ats: points.map((p) => p.at), cumulative };
  preparedCache.set(curve, prepared);
  return prepared;
}

/** Index k of the segment [points[k], points[k+1]] holding `value` along `key`; callers have handled the flat ends. */
function segmentIndex(values: ReadonlyArray<number>, value: number): number {
  let lo = 0, hi = values.length - 2;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if ((values[mid] as number) <= value) lo = mid; else hi = mid - 1;
  }
  return lo;
}

/** Playback rate at source position `s`. */
export function curveRateAt(curve: SpeedCurve, s: number): number {
  const { points, ats } = prepare(curve);
  const first = points[0] as SpeedCurvePoint, last = points[points.length - 1] as SpeedCurvePoint;
  if (s <= first.at) return first.rate;
  if (s >= last.at) return last.rate;
  const k = segmentIndex(ats, s);
  const a = points[k] as SpeedCurvePoint, b = points[k + 1] as SpeedCurvePoint;
  return a.rate + ((b.rate - a.rate) * (s - a.at)) / (b.at - a.at);
}

/** Cumulative timeline time at source position `s` (relative to the first point; only differences are meaningful). */
export function curveTime(curve: SpeedCurve, s: number): number {
  const { points, ats, cumulative } = prepare(curve);
  const first = points[0] as SpeedCurvePoint, last = points[points.length - 1] as SpeedCurvePoint;
  if (s <= first.at) return (s - first.at) / first.rate;
  if (s >= last.at) return (cumulative[cumulative.length - 1] as number) + (s - last.at) / last.rate;
  const k = segmentIndex(ats, s);
  const a = points[k] as SpeedCurvePoint;
  return (cumulative[k] as number) + segmentTime(a.at, s, a.rate, curveRateAt(curve, s));
}

/** Inverse of `curveTime`: the source position reached after cumulative timeline time `t`. */
export function curveSource(curve: SpeedCurve, t: number): number {
  const { points, cumulative } = prepare(curve);
  const first = points[0] as SpeedCurvePoint, last = points[points.length - 1] as SpeedCurvePoint;
  const total = cumulative[cumulative.length - 1] as number;
  if (t <= 0) return first.at + t * first.rate;
  if (t >= total) return last.at + (t - total) * last.rate;
  const k = segmentIndex(cumulative, t);
  const a = points[k] as SpeedCurvePoint, b = points[k + 1] as SpeedCurvePoint;
  const local = t - (cumulative[k] as number);
  if (Math.abs(b.rate - a.rate) <= FLAT * Math.max(a.rate, b.rate)) return a.at + local * a.rate;
  const slope = (b.rate - a.rate) / (b.at - a.at);
  return a.at + (a.rate * Math.exp(slope * local) - a.rate) / slope;
}

/** Why a curve is unusable, or null. */
export function curveProblem(curve: unknown): string | null {
  if (typeof curve !== "object" || curve === null) return "the speed curve is missing";
  const points = (curve as { points?: unknown }).points;
  if (!Array.isArray(points) || points.length < 2) return "a speed curve needs at least 2 points";
  if (points.length > SPEED_CURVE_MAX_POINTS) return `a speed curve has at most ${SPEED_CURVE_MAX_POINTS} points`;
  let previous = -Infinity;
  for (const p of points as Array<Partial<SpeedCurvePoint>>) {
    if (typeof p?.at !== "number" || !Number.isFinite(p.at) || typeof p.rate !== "number" || !Number.isFinite(p.rate)) return "every speed curve point needs a finite position and rate";
    if (p.rate < RETIME_MIN || p.rate > RETIME_MAX) return `speed curve rates must be between ${RETIME_MIN} and ${RETIME_MAX}`;
    if (p.at <= previous) return "speed curve points must be in strictly increasing source order";
    previous = p.at;
  }
  return null;
}

/** A well-formed curve from loose input: sorted, de-duplicated, rates clamped, positions rounded to whole ticks. */
export function normalizeCurve(points: ReadonlyArray<SpeedCurvePoint>): SpeedCurve | null {
  const sorted = points
    .filter((p) => Number.isFinite(p.at) && Number.isFinite(p.rate))
    .map((p) => ({ at: Math.round(p.at), rate: clampRate(p.rate) }))
    .sort((a, b) => a.at - b.at);
  const unique = sorted.filter((p, i) => i === 0 || p.at > (sorted[i - 1] as SpeedCurvePoint).at);
  if (unique.length < 2 || unique.length > SPEED_CURVE_MAX_POINTS) return null;
  return { points: unique };
}

export const SPEED_RAMP_PRESETS = {
  montage: { name: "Montage", description: "Fast cuts that dip into slow motion in the middle, then speed away again.", shape: [[0, 1], [0.25, 3], [0.5, 0.5], [0.75, 3], [1, 1]] },
  hero: { name: "Hero time", description: "Normal speed, a long glide into slow motion at the centre, back to normal.", shape: [[0, 1], [0.35, 1], [0.5, 0.25], [0.65, 1], [1, 1]] },
  bullet: { name: "Bullet", description: "Fast approach, an almost frozen moment, then fast again.", shape: [[0, 2], [0.4, 2], [0.5, 0.1], [0.6, 2], [1, 2]] },
  "jump-cut-ease": { name: "Jump cut ease", description: "Eases in from slow, races through the middle, eases out to slow.", shape: [[0, 0.5], [0.15, 1], [0.5, 4], [0.85, 1], [1, 0.5]] },
} as const satisfies Record<string, { name: string; description: string; shape: ReadonlyArray<readonly [number, number]> }>;
export type SpeedRampPresetId = keyof typeof SPEED_RAMP_PRESETS;
export const SPEED_RAMP_PRESET_IDS = Object.keys(SPEED_RAMP_PRESETS) as SpeedRampPresetId[];

/** Lays normalised (position 0..1 of the window, rate) points over the source window [from, to]. */
export function curveFromShape(input: { shape: ReadonlyArray<readonly [number, number]>; from: number; to: number }): SpeedCurve | null {
  const span = input.to - input.from;
  return normalizeCurve(input.shape.map(([u, rate]) => ({ at: input.from + u * span, rate })));
}

export interface CurveSegment {
  /** Timeline ticks from the clip start. */
  clipOffset: number;
  duration: number;
  /** Absolute source ticks where this segment starts. */
  sourceStart: number;
  /** Constant rate that carries the segment from its source start to its source end exactly. */
  rate: number;
}

/**
 * Splits a clip window into short constant-rate segments whose end points lie exactly on the curve, so a scheduler
 * that only understands constant rates (audio) follows the ramp without drifting. A segment is at most
 * `maxSegmentTicks` long and spans at most `maxRateRatio` change of rate.
 */
export function curveSegments(input: {
  curve: SpeedCurve; trimStart: number; duration: number; maxSegmentTicks: number; maxRateRatio?: number;
}): CurveSegment[] {
  const { curve, trimStart, duration } = input;
  const maxRatio = input.maxRateRatio ?? 1.15;
  const t0 = curveTime(curve, trimStart);
  const cuts = new Set<number>([0, duration]);
  const knots = curve.points.map((p) => curveTime(curve, p.at) - t0).filter((t) => t > 0 && t < duration).map(Math.round);
  for (const k of knots) cuts.add(k);
  const base = [...cuts].sort((a, b) => a - b);
  const bounds: number[] = [];
  for (let i = 0; i + 1 < base.length; i++) {
    const a = base[i] as number, b = base[i + 1] as number;
    const ratio = Math.max(curveRateAt(curve, curveSource(curve, t0 + a)), curveRateAt(curve, curveSource(curve, t0 + b)))
      / Math.min(curveRateAt(curve, curveSource(curve, t0 + a)), curveRateAt(curve, curveSource(curve, t0 + b)));
    const pieces = Math.max(1, Math.ceil((b - a) / input.maxSegmentTicks), Math.ceil(Math.log(ratio) / Math.log(maxRatio)));
    for (let p = 0; p < pieces; p++) bounds.push(Math.round(a + ((b - a) * p) / pieces));
  }
  bounds.push(duration);
  const out: CurveSegment[] = [];
  for (let i = 0; i + 1 < bounds.length; i++) {
    const a = bounds[i] as number, b = bounds[i + 1] as number;
    if (b <= a) continue;
    const sourceStart = curveSource(curve, t0 + a);
    out.push({ clipOffset: a, duration: b - a, sourceStart, rate: (curveSource(curve, t0 + b) - sourceStart) / (b - a) });
  }
  return out;
}
