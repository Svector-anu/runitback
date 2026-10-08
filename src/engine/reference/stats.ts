/** Linear-interpolated quantile (type 7) of an ascending-sorted array; `q` in 0..1. */
export function quantileSorted(sorted: ReadonlyArray<number>, q: number): number {
  const n = sorted.length;
  if (n === 0) return 0;
  const position = Math.min(1, Math.max(0, q)) * (n - 1);
  const lower = Math.floor(position);
  const upper = Math.min(n - 1, lower + 1);
  const low = sorted[lower] as number;
  const high = sorted[upper] as number;
  return low + (high - low) * (position - lower);
}

export const mean = (values: ReadonlyArray<number>): number =>
  values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length;

export const clamp = (value: number, low: number, high: number): number => Math.min(high, Math.max(low, value));

/** Small deterministic PRNG (mulberry32); returns floats in [0, 1). */
export function createRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fisher-Yates in place. */
export function shuffle<T>(items: T[], rng: () => number): T[] {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const a = items[i] as T;
    items[i] = items[j] as T;
    items[j] = a;
  }
  return items;
}
