import { TICKS_PER_SECOND, mediaTime } from "#/engine/time";
import { PARAM, type ElementAnimations, type IdGenerator } from "#/engine/model";
import { removePathAnimation, upsertKeyframe } from "./mutate";

/** One stop of a cursor: where it is (px from the canvas centre, +y down) and when (ticks from the start of the clip). */
export interface CursorWaypoint {
  time: number;
  x: number;
  y: number;
  /** Press and release at this stop: the click ripple plays from `time`. */
  click?: boolean;
}

export const CURSOR_CLICK_PATH = "params.click";
export const CURSOR_PATHS = [PARAM.positionX, PARAM.positionY, CURSOR_CLICK_PATH] as const;
export const CURSOR_CLICK_TICKS = TICKS_PER_SECOND / 2;
export const MAX_CURSOR_WAYPOINTS = 64;

/** Reasons a path cannot be applied, or null. Times must strictly increase and stay inside the clip. */
export function cursorPathProblem(input: { waypoints: ReadonlyArray<CursorWaypoint>; clipDuration: number }): string | null {
  const { waypoints } = input;
  if (waypoints.length === 0) return "the path has no points";
  if (waypoints.length > MAX_CURSOR_WAYPOINTS) return `the path has ${waypoints.length} points; the limit is ${MAX_CURSOR_WAYPOINTS}`;
  for (const [i, w] of waypoints.entries()) {
    if (![w.time, w.x, w.y].every(Number.isFinite)) return `point ${i + 1} has a value that is not a finite number`;
    if (w.time < 0 || w.time > input.clipDuration) return `point ${i + 1} is at ${w.time} ticks, outside the clip (0..${input.clipDuration})`;
    const previous = waypoints[i - 1];
    if (previous && w.time <= previous.time) return `point ${i + 1} is not later than point ${i}`;
  }
  return null;
}

/**
 * Keyframes that move a cursor through `waypoints` (eased between stops; two stops at the same place make it dwell) and
 * play the click ripple at the clicking stops. Replaces any keyframes on position and `click`; other paths are kept.
 */
export function cursorAnimations(input: {
  animations: ElementAnimations | undefined; waypoints: ReadonlyArray<CursorWaypoint>; clipDuration: number; newId: IdGenerator;
}): ElementAnimations {
  let animations = input.animations;
  for (const path of CURSOR_PATHS) animations = removePathAnimation(animations, path);
  const put = (path: string, time: number, value: number, interpolation: "bezier" | "linear" | "hold"): void => {
    animations = upsertKeyframe({ animations, path, time: mediaTime(Math.min(Math.max(0, Math.round(time)), input.clipDuration)), value, interpolation, newId: input.newId });
  };
  for (const w of input.waypoints) {
    put(PARAM.positionX, w.time, w.x, "bezier");
    put(PARAM.positionY, w.time, w.y, "bezier");
  }
  const clicks = input.waypoints.filter((w) => w.click);
  clicks.forEach((w, i) => {
    const nextClick = clicks[i + 1];
    const end = Math.min(w.time + CURSOR_CLICK_TICKS, nextClick ? nextClick.time - 1 : Number.POSITIVE_INFINITY, input.clipDuration);
    if (end <= w.time) return;
    put(CURSOR_CLICK_PATH, w.time, 0, "linear");
    put(CURSOR_CLICK_PATH, end, 1, "hold");
  });
  return animations ?? {};
}
