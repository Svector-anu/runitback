export interface Keyed { t: number; v: number }

/**
 * Ramer-Douglas-Peucker on a (time, value) series: keeps the end points and every point needed so that linear
 * interpolation between the kept ones stays within `tolerance` of every dropped value. Time is rescaled so the
 * perpendicular error is measured in value units only (the series is a function of time, so the vertical gap is exact).
 */
export function thinSeries(points: ReadonlyArray<Keyed>, tolerance: number): Keyed[] {
  if (points.length <= 2) return [...points];
  const keep = new Array<boolean>(points.length).fill(false);
  keep[0] = true;
  keep[points.length - 1] = true;
  const stack: Array<[number, number]> = [[0, points.length - 1]];
  while (stack.length > 0) {
    const [lo, hi] = stack.pop() as [number, number];
    const a = points[lo] as Keyed, b = points[hi] as Keyed;
    let worst = -1, worstError = tolerance;
    for (let i = lo + 1; i < hi; i++) {
      const p = points[i] as Keyed;
      const along = b.t === a.t ? 0 : (p.t - a.t) / (b.t - a.t);
      const error = Math.abs(p.v - (a.v + (b.v - a.v) * along));
      if (error > worstError) { worstError = error; worst = i; }
    }
    if (worst >= 0) { keep[worst] = true; stack.push([lo, worst], [worst, hi]); }
  }
  return points.filter((_, i) => keep[i]);
}
