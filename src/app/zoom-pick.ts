import { TICKS_PER_SECOND } from "#/engine/time";
import type { AutoZoom } from "#/engine/animation";
import { Store } from "./store";

/** The clip waiting for a click on the preview to zoom into, and the amount and hold chosen for it. UI state only. */
export const zoomPickStore = new Store<{ targetElementId: string | null; scale: number; holdSeconds: number }>({ targetElementId: null, scale: 2, holdSeconds: 1.5 });

const EASE_SECONDS = 0.6;
const MIN_EASE_TICKS = Math.round(TICKS_PER_SECOND * 0.1);

/**
 * One push-in starting at `at` ticks into a clip of `clipDuration`: it eases in and back over 0.6 s and holds for `holdSeconds`,
 * shrinking everything proportionally (down to 0.1 s eases) when the clip ends sooner. Null when not even that fits.
 */
export function zoomAtPlayhead(input: {
  at: number; clipDuration: number; point: { x: number; y: number }; scale: number; holdSeconds: number;
}): AutoZoom | null {
  const room = input.clipDuration - input.at;
  const wanted = Math.round((EASE_SECONDS * 2 + input.holdSeconds) * TICKS_PER_SECOND);
  if (room < MIN_EASE_TICKS * 2) return null;
  const k = Math.min(1, room / wanted);
  const ease = Math.max(MIN_EASE_TICKS, Math.round(EASE_SECONDS * TICKS_PER_SECOND * k));
  const hold = Math.max(0, Math.min(Math.round(input.holdSeconds * TICKS_PER_SECOND * k), room - 2 * ease));
  return { at: input.at, x: input.point.x, y: input.point.y, scale: input.scale, inTicks: ease, holdTicks: hold, outTicks: ease };
}
