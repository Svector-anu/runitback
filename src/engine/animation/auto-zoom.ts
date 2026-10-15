import { PARAM, numberParam, type ElementAnimations, type IdGenerator, type ParamValues } from "#/engine/model";
import { mediaTime } from "#/engine/time";
import { removePathAnimation, upsertKeyframe } from "./mutate";

/** One push-in on a point of the picture, in ticks from the start of the clip. */
export interface AutoZoom {
  at: number;
  /** The point to zoom into, in canvas pixels from the canvas centre (+y down), as seen before the zoom. */
  x: number;
  y: number;
  /** How much bigger the picture gets (1.1 to 8). */
  scale: number;
  /** Ticks to ease in. */
  inTicks: number;
  /** Ticks to stay zoomed. */
  holdTicks: number;
  /** Ticks to ease back to the starting framing; 0 stays zoomed until the next zoom (or the end). */
  outTicks: number;
}

export const AUTO_ZOOM_MIN_SCALE = 1.1;
export const AUTO_ZOOM_MAX_SCALE = 8;
export const MAX_AUTO_ZOOMS = 8;
export const AUTO_ZOOM_PATHS = [PARAM.scaleX, PARAM.scaleY, PARAM.positionX, PARAM.positionY] as const;

interface Framing { scaleX: number; scaleY: number; x: number; y: number }

/** The framing that puts screen point `(px, py)` of `from` at the centre of the canvas, `k` times bigger. */
export function zoomedFraming(input: { from: Framing; px: number; py: number; k: number }): Framing {
  const { from, k } = input;
  return { scaleX: from.scaleX * k, scaleY: from.scaleY * k, x: k * (from.x - input.px), y: k * (from.y - input.py) };
}

/** Why a list of zooms cannot be applied to a clip of `clipDuration` ticks, or null. They must be in order and must not overlap. */
export function autoZoomProblem(input: { zooms: ReadonlyArray<AutoZoom>; clipDuration: number }): string | null {
  const { zooms } = input;
  if (zooms.length === 0) return "there are no zooms";
  if (zooms.length > MAX_AUTO_ZOOMS) return `there are ${zooms.length} zooms; the limit is ${MAX_AUTO_ZOOMS}`;
  let previousEnd = -1;
  for (const [i, z] of zooms.entries()) {
    const label = `zoom ${i + 1}`;
    if (![z.at, z.x, z.y, z.scale, z.inTicks, z.holdTicks, z.outTicks].every(Number.isFinite)) return `${label} has a value that is not a finite number`;
    if (z.scale < AUTO_ZOOM_MIN_SCALE || z.scale > AUTO_ZOOM_MAX_SCALE) return `${label} scale must be between ${AUTO_ZOOM_MIN_SCALE} and ${AUTO_ZOOM_MAX_SCALE}`;
    if (z.inTicks < 1 || z.holdTicks < 0 || z.outTicks < 0) return `${label} needs a positive ease-in and non-negative hold and ease-out`;
    if (z.at < 0) return `${label} starts before the clip`;
    const end = z.at + z.inTicks + z.holdTicks + z.outTicks;
    if (end > input.clipDuration) return `${label} runs past the end of the clip (it needs ${end} ticks, the clip has ${input.clipDuration})`;
    if (z.at < previousEnd) return `${label} starts before zoom ${i} has finished`;
    previousEnd = end;
  }
  return null;
}

/**
 * Keyframes for a series of push-ins on a still or moving clip. Position and scale keys are eased (smooth in and out), and
 * every zoom is expressed from the framing the clip had before it, so a clip that was already scaled or moved keeps its look
 * between zooms. Replaces earlier keyframes on scale and position.
 */
export function autoZoomAnimations(input: {
  animations: ElementAnimations | undefined; params: ParamValues; zooms: ReadonlyArray<AutoZoom>; newId: IdGenerator;
}): ElementAnimations {
  const base: Framing = {
    scaleX: numberParam(input.params, PARAM.scaleX, 1), scaleY: numberParam(input.params, PARAM.scaleY, 1),
    x: numberParam(input.params, PARAM.positionX, 0), y: numberParam(input.params, PARAM.positionY, 0),
  };
  let animations = input.animations;
  for (const path of AUTO_ZOOM_PATHS) animations = removePathAnimation(animations, path);
  const put = (time: number, f: Framing): void => {
    const at = mediaTime(Math.round(time));
    const values: Record<(typeof AUTO_ZOOM_PATHS)[number], number> = { [PARAM.scaleX]: f.scaleX, [PARAM.scaleY]: f.scaleY, [PARAM.positionX]: f.x, [PARAM.positionY]: f.y };
    for (const path of AUTO_ZOOM_PATHS) animations = upsertKeyframe({ animations, path, time: at, value: values[path], interpolation: "bezier", newId: input.newId });
  };
  let resting = base;
  for (const z of input.zooms) {
    put(z.at, resting);
    const zoomed = zoomedFraming({ from: resting, px: z.x, py: z.y, k: z.scale });
    put(z.at + z.inTicks, zoomed);
    if (z.holdTicks > 0) put(z.at + z.inTicks + z.holdTicks, zoomed);
    if (z.outTicks > 0) {
      resting = base;
      put(z.at + z.inTicks + z.holdTicks + z.outTicks, resting);
    } else {
      resting = zoomed;
    }
  }
  return animations ?? {};
}
