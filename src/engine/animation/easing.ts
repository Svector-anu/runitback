import { roundMediaTime } from "#/engine/time";
import type { CurveHandle, ScalarKey, SegmentType } from "#/engine/model";

/** CSS-style cubic bezier: control points (x1,y1) and (x2,y2) with endpoints fixed at (0,0) and (1,1). */
export type NormalizedCurve = readonly [number, number, number, number];

export interface EasingPreset {
  id: string;
  label: string;
  curve: NormalizedCurve;
}

export const EASING_PRESETS: ReadonlyArray<EasingPreset> = [
  { id: "smooth", label: "Smooth", curve: [0.25, 0.1, 0.25, 1] },
  { id: "ease-out", label: "Ease out", curve: [0, 0, 0.2, 1] },
  { id: "ease-in", label: "Ease in", curve: [0.8, 0, 1, 1] },
  { id: "in-out", label: "In out", curve: [0.4, 0, 0.2, 1] },
  { id: "pop", label: "Pop", curve: [0.175, 0.885, 0.32, 1.275] },
  { id: "linear", label: "Linear", curve: [0, 0, 1, 1] },
];

const clamp01 = (n: number): number => Math.min(1, Math.max(0, n));
const EPSILON = 1e-6;

export function isLinearCurve(curve: NormalizedCurve): boolean {
  return Math.abs(curve[0]) < EPSILON && Math.abs(curve[1]) < EPSILON && Math.abs(curve[2] - 1) < EPSILON && Math.abs(curve[3] - 1) < EPSILON;
}

export interface SegmentCurvePatch {
  segmentToNext: SegmentType;
  rightHandle: CurveHandle | null;
  leftHandle: CurveHandle | null;
}

/** Patches for the left key (right handle) and the next key (left handle) that realise `curve` on that segment. */
export function curveToPatch(input: { left: ScalarKey; right: ScalarKey; curve: NormalizedCurve }): SegmentCurvePatch | null {
  const span = input.right.time - input.left.time;
  const valueSpan = input.right.value - input.left.value;
  if (span <= 0) return null;
  if (isLinearCurve(input.curve)) return { segmentToNext: "linear", rightHandle: null, leftHandle: null };
  if (Math.abs(valueSpan) < EPSILON) return null;
  const [x1, y1, x2, y2] = input.curve;
  return {
    segmentToNext: "bezier",
    rightHandle: { dt: roundMediaTime(span * clamp01(x1)), dv: valueSpan * y1 },
    leftHandle: { dt: roundMediaTime(span * (clamp01(x2) - 1)), dv: valueSpan * (y2 - 1) },
  };
}

/** The normalised curve a segment currently follows, or null for hold segments and flat value spans. */
export function segmentToCurve(input: { left: ScalarKey; right: ScalarKey }): NormalizedCurve | null {
  const { left, right } = input;
  const span = right.time - left.time;
  const valueSpan = right.value - left.value;
  if (left.segmentToNext === "step" || span <= 0) return null;
  if (left.segmentToNext === "linear") return [0, 0, 1, 1];
  if (Math.abs(valueSpan) < EPSILON) return null;
  const rh = left.rightHandle ?? { dt: span / 3, dv: valueSpan / 3 };
  const lh = right.leftHandle ?? { dt: -span / 3, dv: -valueSpan / 3 };
  return [clamp01(rh.dt / span), rh.dv / valueSpan, clamp01(1 + lh.dt / span), 1 + lh.dv / valueSpan];
}

export function matchPreset(curve: NormalizedCurve, tolerance = 0.02): EasingPreset | null {
  return EASING_PRESETS.find((p) => p.curve.every((v, i) => Math.abs(v - (curve[i] as number)) <= tolerance)) ?? null;
}
