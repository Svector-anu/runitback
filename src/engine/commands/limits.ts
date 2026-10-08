import type { FrameRate } from "#/engine/time";

export const MAX_CANVAS_SIDE = 8192;
export const MAX_CANVAS_PIXELS = 33_000_000;
export const MAX_FPS = 240;

export function isSaneCanvas(width: number, height: number): boolean {
  return Number.isInteger(width) && Number.isInteger(height) && width >= 16 && height >= 16
    && width <= MAX_CANVAS_SIDE && height <= MAX_CANVAS_SIDE && width * height <= MAX_CANVAS_PIXELS;
}

export function isSaneFrameRate(rate: FrameRate): boolean {
  if (!Number.isInteger(rate.numerator) || !Number.isInteger(rate.denominator) || rate.numerator <= 0 || rate.denominator <= 0) return false;
  const fps = rate.numerator / rate.denominator;
  return fps >= 1 && fps <= MAX_FPS;
}
