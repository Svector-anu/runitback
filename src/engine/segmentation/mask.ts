import { MASK_TRACK_VERSION, type MaskFrame, type MaskTrack } from "./types";

/** Sampling rate of the analysis: the clip's own frame rate, capped, and the total frame count capped for long media. */
export const MASK_MAX_FPS = 12;
export const MASK_MAX_FRAMES = 1800;

/** Source times to segment: evenly spaced, at most `MASK_MAX_FPS` per second and `MASK_MAX_FRAMES` in total; one time for a still image. */
export function planMaskTimes(input: { durationSeconds: number; fps?: number; isStill?: boolean }): number[] {
  if (input.isStill || !(input.durationSeconds > 0)) return [0];
  const rate = Math.max(1, Math.min(MASK_MAX_FPS, input.fps ?? MASK_MAX_FPS));
  const count = Math.max(1, Math.min(MASK_MAX_FRAMES, Math.floor(input.durationSeconds * rate)));
  const step = input.durationSeconds / count;
  return Array.from({ length: count }, (_, i) => i * step);
}

export function isUsableMaskTrack(value: unknown, model: string): value is MaskTrack {
  if (typeof value !== "object" || value === null) return false;
  const t = value as Partial<MaskTrack>;
  return t.version === MASK_TRACK_VERSION && t.model === model && Number.isInteger(t.width) && Number.isInteger(t.height)
    && Array.isArray(t.times) && Array.isArray(t.frames) && t.times.length === t.frames.length && t.times.length > 0
    && t.frames.every((f) => f instanceof Uint8Array && f.length === (t.width as number) * (t.height as number));
}

/**
 * The mask at source time `t`: the nearest sample, or a blend of the two surrounding ones. Blending (not snapping)
 * hides the step between samples when the person moves slowly; fast motion between samples still ghosts, which is the
 * price of not running the model on every frame.
 */
export function maskAt(track: MaskTrack, t: number): MaskFrame {
  const { times, frames, width, height } = track;
  const last = times.length - 1;
  if (t <= (times[0] as number)) return { width, height, data: frames[0] as Uint8Array };
  if (t >= (times[last] as number)) return { width, height, data: frames[last] as Uint8Array };
  let lo = 0, hi = last;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if ((times[mid] as number) <= t) lo = mid; else hi = mid;
  }
  const a = frames[lo] as Uint8Array, b = frames[hi] as Uint8Array;
  const w = ((t - (times[lo] as number)) / ((times[hi] as number) - (times[lo] as number)));
  if (w <= 0.001) return { width, height, data: a };
  if (w >= 0.999) return { width, height, data: b };
  const out = new Uint8Array(a.length);
  const wb = Math.round(w * 256), wa = 256 - wb;
  for (let i = 0; i < a.length; i++) out[i] = ((a[i] as number) * wa + (b[i] as number) * wb) >> 8;
  return { width, height, data: out };
}

/** Alpha 0..255 from confidence 0..255: a smoothstep around 0.5 whose width grows with `softness` (0..100); `invert` keeps the background. */
export function maskAlphaTable(input: { softness: number; invert: boolean }): Uint8Array {
  const half = 0.02 + (Math.min(100, Math.max(0, input.softness)) / 100) * 0.48;
  const table = new Uint8Array(256);
  for (let v = 0; v < 256; v++) {
    const x = Math.min(1, Math.max(0, (v / 255 - (0.5 - half)) / (2 * half)));
    const a = x * x * (3 - 2 * x);
    table[v] = Math.round((input.invert ? 1 - a : a) * 255);
  }
  return table;
}

/** Share of the frame the mask calls person (confidence over half); a quick health number for tests and UI. */
export function maskCoverage(frame: MaskFrame): number {
  let n = 0;
  for (let i = 0; i < frame.data.length; i++) if ((frame.data[i] as number) > 127) n++;
  return n / Math.max(1, frame.data.length);
}
