import { TICKS_PER_SECOND, clampTime, mediaTime, roundMediaTime, type MediaTime } from "./media-time";

export interface FrameRate {
  numerator: number;
  denominator: number;
}

export const DEFAULT_FPS: FrameRate = { numerator: 30, denominator: 1 };

export function frameRateFromFloat(fps: number): FrameRate {
  if (!Number.isFinite(fps) || fps <= 0) throw new RangeError(`Invalid fps ${fps}`);
  const known: Array<[number, FrameRate]> = [
    [23.976, { numerator: 24000, denominator: 1001 }],
    [29.97, { numerator: 30000, denominator: 1001 }],
    [47.952, { numerator: 48000, denominator: 1001 }],
    [59.94, { numerator: 60000, denominator: 1001 }],
  ];
  for (const [approx, rate] of known) {
    if (Math.abs(fps - approx) < 0.005) return rate;
  }
  const rounded = Math.round(fps);
  if (Math.abs(fps - rounded) < 0.01) return { numerator: rounded, denominator: 1 };
  return { numerator: Math.round(fps * 1000), denominator: 1000 };
}

export function frameRateToFloat(rate: FrameRate): number {
  return rate.numerator / rate.denominator;
}

export function isSameFrameRate(a: FrameRate, b: FrameRate): boolean {
  return a.numerator * b.denominator === b.numerator * a.denominator;
}

/** Exact ticks per frame when the rate divides the tick grid evenly, otherwise null. */
export function exactTicksPerFrame(rate: FrameRate): number | null {
  const ticks = (TICKS_PER_SECOND * rate.denominator) / rate.numerator;
  return Number.isInteger(ticks) ? ticks : null;
}

/** Nominal frame length, rounded for rates that do not divide the tick grid. */
export function frameDuration(rate: FrameRate): MediaTime {
  return roundMediaTime((TICKS_PER_SECOND * rate.denominator) / rate.numerator);
}

function frameIndexExact(time: number, rate: FrameRate): number {
  return (time * rate.numerator) / (TICKS_PER_SECOND * rate.denominator);
}

export function frameStartTime(index: number, rate: FrameRate): MediaTime {
  return roundMediaTime((index * TICKS_PER_SECOND * rate.denominator) / rate.numerator);
}

export function frameIndexAt(time: number, rate: FrameRate): number {
  return Math.floor(frameIndexExact(time, rate) + 1e-9);
}

export function roundToFrame(time: number, rate: FrameRate): MediaTime {
  return frameStartTime(Math.round(frameIndexExact(time, rate)), rate);
}

export function floorToFrame(time: number, rate: FrameRate): MediaTime {
  return frameStartTime(frameIndexAt(time, rate), rate);
}

/** Seek target: nearest frame boundary, clamped to [0, duration]. May equal `duration`. */
export function snappedSeekTime(time: number, duration: number, rate: FrameRate): MediaTime {
  return clampTime(roundToFrame(time, rate), 0, Math.max(0, duration));
}

/** Start time of the last renderable frame (0 for empty timelines). */
export function lastFrameTime(duration: number, rate: FrameRate): MediaTime {
  if (duration <= 0) return mediaTime(0);
  return floorToFrame(duration - 1, rate);
}

export function formatTimecode(time: number, rate: FrameRate): string {
  const fps = Math.max(1, Math.round(frameRateToFloat(rate)));
  const totalFrames = frameIndexAt(Math.max(0, time), rate);
  const frames = totalFrames % fps;
  const totalSeconds = Math.floor(totalFrames / fps);
  const seconds = totalSeconds % 60;
  const minutes = Math.floor(totalSeconds / 60) % 60;
  const hours = Math.floor(totalSeconds / 3600);
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}:${pad(frames)}`;
}

export function parseTimecode(text: string, rate: FrameRate): MediaTime | null {
  const parts = text.trim().split(":").map(Number);
  if (parts.length < 1 || parts.length > 4 || parts.some((p) => !Number.isFinite(p) || p < 0)) return null;
  const fps = Math.max(1, Math.round(frameRateToFloat(rate)));
  const [f = 0, s = 0, m = 0, h = 0] = [...parts].reverse();
  const frames = (h * 3600 + m * 60 + s) * fps + f;
  return frameStartTime(frames, rate);
}
