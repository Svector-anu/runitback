export const BEZIER_SOLVE_ITERATIONS = 20;

export interface Point { x: number; y: number }

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function lerpPoint(a: Point, b: Point, t: number): Point {
  return { x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t) };
}

export function cubicPoint(p0: Point, p1: Point, p2: Point, p3: Point, u: number): Point {
  const v = 1 - u;
  const w0 = v * v * v, w1 = 3 * v * v * u, w2 = 3 * v * u * u, w3 = u * u * u;
  return {
    x: w0 * p0.x + w1 * p1.x + w2 * p2.x + w3 * p3.x,
    y: w0 * p0.y + w1 * p1.y + w2 * p2.y + w3 * p3.y,
  };
}

/** Solves x(u) = x by bisection; assumes x is monotone in u (guaranteed by handle clamping). */
export function solveParameterForX(p0: Point, p1: Point, p2: Point, p3: Point, x: number): number {
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < BEZIER_SOLVE_ITERATIONS; i++) {
    const mid = (lo + hi) / 2;
    if (cubicPoint(p0, p1, p2, p3, mid).x < x) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

export interface SplitCubic {
  left: [Point, Point, Point, Point];
  right: [Point, Point, Point, Point];
}

/** Exact de Casteljau subdivision at parameter u. */
export function subdivideCubic(p0: Point, p1: Point, p2: Point, p3: Point, u: number): SplitCubic {
  const q0 = lerpPoint(p0, p1, u);
  const q1 = lerpPoint(p1, p2, u);
  const q2 = lerpPoint(p2, p3, u);
  const r0 = lerpPoint(q0, q1, u);
  const r1 = lerpPoint(q1, q2, u);
  const s = lerpPoint(r0, r1, u);
  return { left: [p0, q0, r0, s], right: [s, r1, q2, p3] };
}
