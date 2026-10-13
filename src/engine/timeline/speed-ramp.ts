import { SPEED_CURVE_MAX_POINTS, clampRate, type RetimeConfig } from "#/engine/model";
import { sourceTimeAt } from "./retime";
import { SPEED_RAMP_PRESETS, curveFromShape, curveRateAt, type SpeedRampPresetId } from "./speed-curve";

/** A ramp as the user thinks of it: position along the clip's visible source (0..1) and the speed there. */
export interface RampShapePoint { position: number; speed: number }

interface RampHost {
  trimStart: number;
  duration: number;
  retime?: RetimeConfig | undefined;
}

/** Source range [from, to] (absolute ticks) the clip currently shows. */
export function visibleSourceRange(element: RampHost): { from: number; to: number } {
  return { from: element.trimStart, to: sourceTimeAt({ trimStart: element.trimStart, clipTime: element.duration, retime: element.retime }) };
}

const EPSILON = 1e-6;

/** The clip's speed over its visible source as 2..6 shape points; constant speed is a flat 2-point shape. */
export function currentRampShape(element: RampHost): RampShapePoint[] {
  const { from, to } = visibleSourceRange(element);
  const curve = element.retime?.curve;
  const span = Math.max(1, to - from);
  if (!curve) {
    const speed = element.retime ? clampRate(element.retime.rate) : 1;
    return [{ position: 0, speed }, { position: 1, speed }];
  }
  const inner = curve.points.filter((p) => p.at > from + span * EPSILON && p.at < to - span * EPSILON).map((p) => ({ position: (p.at - from) / span, speed: p.rate }));
  const ends = [{ position: 0, speed: curveRateAt(curve, from) }, { position: 1, speed: curveRateAt(curve, to) }];
  return [ends[0] as RampShapePoint, ...inner.slice(0, SPEED_CURVE_MAX_POINTS - 2), ends[1] as RampShapePoint];
}

export function presetShape(id: SpeedRampPresetId): RampShapePoint[] {
  return SPEED_RAMP_PRESETS[id].shape.map(([position, speed]) => ({ position, speed }));
}

/** Why a shape cannot be a ramp, or null. */
export function rampShapeProblem(shape: ReadonlyArray<RampShapePoint>): string | null {
  if (shape.length < 2 || shape.length > SPEED_CURVE_MAX_POINTS) return `a speed ramp needs 2 to ${SPEED_CURVE_MAX_POINTS} points, got ${shape.length}`;
  let previous = -Infinity;
  for (const p of shape) {
    if (!Number.isFinite(p.position) || p.position < 0 || p.position > 1) return "ramp positions must be between 0 and 1";
    if (!Number.isFinite(p.speed)) return "ramp speeds must be finite numbers";
    if (p.position <= previous) return "ramp positions must be strictly increasing";
    previous = p.position;
  }
  return null;
}

/**
 * The retime that applies `shape` to the clip's visible source. The first and last point sit at the window edges
 * unless the shape stops short of them (then the end speeds hold flat). The caller's update pipeline derives the
 * new duration and keeps `rate` equal to the mean.
 */
export function retimeForShape(input: { element: RampHost; shape: ReadonlyArray<RampShapePoint>; maintainPitch?: boolean | undefined }): RetimeConfig | null {
  const { from, to } = visibleSourceRange(input.element);
  const curve = curveFromShape({ shape: input.shape.map((p) => [p.position, p.speed] as const), from, to });
  if (!curve) return null;
  const maintain = input.maintainPitch ?? input.element.retime?.maintainPitch;
  return { rate: 1, curve, ...(maintain === undefined ? {} : { maintainPitch: maintain }) };
}
