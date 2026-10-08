import { shotBounds } from "./moments";

export const DEFAULT_SAMPLE_INTERVAL_SECONDS = 2;
/** Caps the work and storage for one asset: 300 frames is 10 minutes at the default interval. */
export const DEFAULT_MAX_FRAMES = 300;

const roundMs = (seconds: number): number => Math.round(seconds * 1000) / 1000;

function pickEvenly<T>(items: ReadonlyArray<T>, count: number): T[] {
  if (count >= items.length) return [...items];
  return Array.from({ length: count }, (_, i) => items[Math.floor(((i + 0.5) * items.length) / count)] as T);
}

/**
 * Which source times to look at: the midpoint of every shot (so each shot is seen once however short), plus one frame
 * every `intervalSeconds` so long shots are covered. Grid frames within a quarter interval of a shot midpoint are
 * redundant and dropped. Above `maxFrames` the grid is thinned evenly first, then the shot midpoints.
 */
export function planFrameTimes(input: { durationSeconds: number; cutTimes: ReadonlyArray<number>; intervalSeconds?: number; maxFrames?: number }): number[] {
  const { durationSeconds } = input;
  const interval = input.intervalSeconds ?? DEFAULT_SAMPLE_INTERVAL_SECONDS;
  const maxFrames = Math.max(1, Math.floor(input.maxFrames ?? DEFAULT_MAX_FRAMES));
  if (!(durationSeconds > 0) || !(interval > 0)) return [];

  const bounds = shotBounds({ durationSeconds, cuts: input.cutTimes });
  const mids = bounds.slice(0, -1).map((start, i) => roundMs((start + (bounds[i + 1] as number)) / 2));
  const grid: number[] = [];
  for (let k = 0; (k + 0.5) * interval < durationSeconds; k++) grid.push(roundMs((k + 0.5) * interval));
  const separation = interval / 4;
  const distinctGrid = grid.filter((t) => !mids.some((m) => Math.abs(m - t) < separation));

  const keptMids = pickEvenly(mids, maxFrames);
  const keptGrid = pickEvenly(distinctGrid, Math.max(0, maxFrames - keptMids.length));
  return [...new Set([...keptMids, ...keptGrid])].sort((a, b) => a - b);
}
