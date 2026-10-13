import { RETIME_MAX, SPEED_CURVE_MAX_POINTS } from "#/engine/model";
import type { RampShapePoint } from "#/engine/timeline";

/** The editor shows speeds on a log scale between these bounds (the engine itself allows 0.01x). */
export const VIEW_MIN_SPEED = 0.1;
export const VIEW_MAX_SPEED = RETIME_MAX;
/** Closest two neighbouring points may get, as a fraction of the clip's visible source. */
export const MIN_POINT_GAP = 0.02;

const LOG_RANGE = Math.log(VIEW_MAX_SPEED / VIEW_MIN_SPEED);

/** 0 at the top (fastest) to 1 at the bottom (slowest). */
export const speedToY = (speed: number): number => 1 - Math.log(Math.min(VIEW_MAX_SPEED, Math.max(VIEW_MIN_SPEED, speed)) / VIEW_MIN_SPEED) / LOG_RANGE;
export const yToSpeed = (y: number): number => roundSpeed(VIEW_MIN_SPEED * Math.exp((1 - Math.min(1, Math.max(0, y))) * LOG_RANGE));

const roundSpeed = (speed: number): number => Math.min(VIEW_MAX_SPEED, Math.max(VIEW_MIN_SPEED, Math.round(speed * 100) / 100));

/** Moves one point. The first and last stay on the clip's edges (only their speed changes); inner points stay between their neighbours. */
export function movePoint(shape: ReadonlyArray<RampShapePoint>, index: number, to: { position: number; speed: number }): RampShapePoint[] {
  const last = shape.length - 1;
  return shape.map((point, i) => {
    if (i !== index) return point;
    if (i === 0 || i === last) return { position: point.position, speed: roundSpeed(to.speed) };
    const low = (shape[i - 1] as RampShapePoint).position + MIN_POINT_GAP;
    const high = (shape[i + 1] as RampShapePoint).position - MIN_POINT_GAP;
    return { position: Math.round(Math.min(high, Math.max(low, to.position)) * 1000) / 1000, speed: roundSpeed(to.speed) };
  });
}

/** Linear speed between the neighbouring points at `position`. */
export function speedAt(shape: ReadonlyArray<RampShapePoint>, position: number): number {
  const next = shape.findIndex((p) => p.position >= position);
  if (next <= 0) return (shape[Math.max(0, next)] as RampShapePoint).speed;
  const a = shape[next - 1] as RampShapePoint, b = shape[next] as RampShapePoint;
  return a.speed + ((b.speed - a.speed) * (position - a.position)) / (b.position - a.position);
}

/** Adds a point on the line at `position`; null when the shape is full or the spot is too close to a neighbour. */
export function addPoint(shape: ReadonlyArray<RampShapePoint>, position: number): RampShapePoint[] | null {
  if (shape.length >= SPEED_CURVE_MAX_POINTS) return null;
  if (shape.some((p) => Math.abs(p.position - position) < MIN_POINT_GAP)) return null;
  const point = { position: Math.round(position * 1000) / 1000, speed: roundSpeed(speedAt(shape, position)) };
  return [...shape, point].sort((a, b) => a.position - b.position);
}

/** Removes an inner point; the end points and the 2-point minimum stay. */
export function removePoint(shape: ReadonlyArray<RampShapePoint>, index: number): RampShapePoint[] | null {
  if (index <= 0 || index >= shape.length - 1) return null;
  return shape.filter((_, i) => i !== index);
}
