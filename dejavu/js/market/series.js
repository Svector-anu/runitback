/** Replaces candles with the same open time and keeps the series ordered. Returns a new array. */
export function mergeCandles(existing, incoming) {
  const byTime = new Map(existing.map((candle) => [candle.t, candle]));
  for (const candle of incoming) byTime.set(candle.t, candle);
  return [...byTime.values()].sort((a, b) => a.t - b.t);
}

export function isClosed(candle, intervalMs, now) {
  return candle.t + intervalMs <= now;
}

/** Structural problems that would make a chart lie. Gaps are real market gaps, reported but not errors. */
export function inspectSeries(candles, intervalMs) {
  const problems = [];
  let gaps = 0;
  for (let i = 0; i < candles.length; i++) {
    const { t, o, h, l, c, v } = candles[i];
    if (!(o > 0 && h > 0 && l > 0 && c > 0)) problems.push(`non-positive price at ${t}`);
    if (h < Math.max(o, c, l) || l > Math.min(o, c, h)) problems.push(`inconsistent high/low at ${t}`);
    if (v < 0) problems.push(`negative volume at ${t}`);
    if (i > 0) {
      const step = t - candles[i - 1].t;
      if (step <= 0) problems.push(`out-of-order candle at ${t}`);
      else if (step > intervalMs) gaps += Math.round(step / intervalMs) - 1;
    }
  }
  return { ok: problems.length === 0, problems, gaps };
}

/** Index of the candle whose period contains t, or -1. */
export function indexAtTime(candles, intervalMs, t) {
  let lo = 0;
  let hi = candles.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const start = candles[mid].t;
    if (t < start) hi = mid - 1;
    else if (t >= start + intervalMs) lo = mid + 1;
    else return mid;
  }
  return -1;
}

/** Index of the first candle with open time >= t (candles.length when none). */
export function lowerBound(candles, t) {
  let lo = 0;
  let hi = candles.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (candles[mid].t < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
