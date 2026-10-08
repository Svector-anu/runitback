export const TICKS_PER_SECOND = 120_000;

export type MediaTime = number & { readonly __brand: "MediaTime" };

export const ZERO_TIME = 0 as MediaTime;

export function mediaTime(ticks: number): MediaTime {
  if (!Number.isInteger(ticks)) {
    throw new RangeError(`MediaTime must be an integer tick count, got ${ticks}`);
  }
  return ticks as MediaTime;
}

/** Rounds half away from zero so that symmetric math (negate/round) stays symmetric. */
export function roundMediaTime(value: number): MediaTime {
  if (!Number.isFinite(value)) throw new RangeError(`Cannot round non-finite time ${value}`);
  return (Math.sign(value) * Math.round(Math.abs(value))) as MediaTime;
}

export function mediaTimeFromSeconds(seconds: number): MediaTime {
  return roundMediaTime(seconds * TICKS_PER_SECOND);
}

export function toSeconds(time: number): number {
  return time / TICKS_PER_SECOND;
}

export function addTime(a: number, b: number): MediaTime {
  return mediaTime(a + b);
}

export function subTime(a: number, b: number): MediaTime {
  return mediaTime(a - b);
}

export function clampTime(time: number, min: number, max: number): MediaTime {
  return mediaTime(Math.min(Math.max(time, min), max));
}

export function maxTime(...times: number[]): MediaTime {
  return mediaTime(Math.max(...times));
}

export function minTime(...times: number[]): MediaTime {
  return mediaTime(Math.min(...times));
}
