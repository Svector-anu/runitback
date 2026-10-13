import { EFFECT_DEFINITIONS, GRAPHIC_DEFINITIONS, MASK_DEFINITIONS, type ParamDef } from "./definitions";
import { CROP_MAX_EDGE, PARAM, VOLUME_DB_MAX, VOLUME_DB_MIN } from "./params";
import type { Effect, Mask, ParamValues, TimelineElement } from "./types";

/** Letters, digits, spaces, underscores and hyphens: keeps document-supplied names out of URLs and CSS font shorthands. */
const SAFE_FONT_FAMILY = /^[\p{L}\p{N} _-]{1,64}$/u;
export const DEFAULT_FONT_FAMILY = "Arial";

export function isSafeFontFamily(family: string): boolean {
  return SAFE_FONT_FAMILY.test(family);
}

export interface NumberLimit { min: number; max: number }

/**
 * Hard bounds for the numeric parameters every element can carry. The inspector uses the same table, so a value
 * the UI would refuse is also refused (clamped) when it arrives through an agent tool, a paste, or a damaged file.
 */
export const ELEMENT_NUMBER_LIMITS: Readonly<Record<string, NumberLimit>> = {
  [PARAM.positionX]: { min: -100_000, max: 100_000 },
  [PARAM.positionY]: { min: -100_000, max: 100_000 },
  [PARAM.scaleX]: { min: 0.01, max: 100 },
  [PARAM.scaleY]: { min: 0.01, max: 100 },
  [PARAM.rotate]: { min: -36_000, max: 36_000 },
  [PARAM.opacity]: { min: 0, max: 1 },
  [PARAM.volume]: { min: VOLUME_DB_MIN, max: VOLUME_DB_MAX },
  [PARAM.denoise]: { min: 0, max: 1 },
  [PARAM.cropLeft]: { min: 0, max: CROP_MAX_EDGE },
  [PARAM.cropTop]: { min: 0, max: CROP_MAX_EDGE },
  [PARAM.cropRight]: { min: 0, max: CROP_MAX_EDGE },
  [PARAM.cropBottom]: { min: 0, max: CROP_MAX_EDGE },
};

export const TEXT_NUMBER_LIMITS: Readonly<Record<string, NumberLimit>> = {
  [PARAM.fontSize]: { min: 1, max: 500 },
  [PARAM.letterSpacing]: { min: -100, max: 1000 },
  [PARAM.lineHeight]: { min: 0.1, max: 10 },
  [PARAM.bgCornerRadius]: { min: 0, max: 100 },
  [PARAM.bgPaddingX]: { min: 0, max: 10_000 },
  [PARAM.bgPaddingY]: { min: 0, max: 10_000 },
  [PARAM.bgOffsetX]: { min: -100_000, max: 100_000 },
  [PARAM.bgOffsetY]: { min: -100_000, max: 100_000 },
  [PARAM.strokeWidth]: { min: 0, max: 200 },
  [PARAM.shadowBlur]: { min: 0, max: 200 },
  [PARAM.shadowOffsetX]: { min: -1000, max: 1000 },
  [PARAM.shadowOffsetY]: { min: -1000, max: 1000 },
  [PARAM.reveal]: { min: 0, max: 1 },
  [PARAM.blur]: { min: 0, max: 100 },
  [PARAM.wordReveal]: { min: 0, max: 1 },
  [PARAM.highlightWord]: { min: -1, max: 100_000 },
};

export function limitsOfDefinitions(defs: ReadonlyArray<ParamDef>): Record<string, NumberLimit> {
  const out: Record<string, NumberLimit> = {};
  for (const def of defs) {
    if (def.type === "number" && def.min !== undefined && def.max !== undefined) out[def.key] = { min: def.min, max: def.max };
  }
  return out;
}

/** Limits that apply to `element.params` (and to keyframe values on the same keys). */
export function limitsForElement(element: Pick<TimelineElement, "type"> & { definitionId?: string; effectType?: string }): Record<string, NumberLimit> {
  const limits: Record<string, NumberLimit> = { ...ELEMENT_NUMBER_LIMITS };
  if (element.type === "text") Object.assign(limits, TEXT_NUMBER_LIMITS);
  if (element.type === "graphic" && element.definitionId) {
    Object.assign(limits, limitsOfDefinitions(GRAPHIC_DEFINITIONS[element.definitionId]?.params ?? []));
  }
  if (element.type === "effect" && element.effectType) {
    Object.assign(limits, limitsOfDefinitions(EFFECT_DEFINITIONS[element.effectType]?.params ?? []));
  }
  return limits;
}

export function limitsForEffect(effect: Pick<Effect, "type">): Record<string, NumberLimit> {
  return limitsOfDefinitions(EFFECT_DEFINITIONS[effect.type]?.params ?? []);
}

export function limitsForMask(mask: Pick<Mask, "type">): Record<string, NumberLimit> {
  return limitsOfDefinitions(MASK_DEFINITIONS[mask.type]?.params ?? []);
}

export function clampToLimit(value: number, limit: NumberLimit): number {
  return Math.min(limit.max, Math.max(limit.min, value));
}

/** Clamps every finite number that has a limit; returns the same object when nothing changed. Non-finite values are left to the caller. */
export function clampParams(params: ParamValues, limits: Readonly<Record<string, NumberLimit>>): ParamValues {
  let out: ParamValues | null = null;
  for (const [key, value] of Object.entries(params)) {
    const limit = limits[key];
    if (!limit || typeof value !== "number" || !Number.isFinite(value)) continue;
    const clamped = clampToLimit(value, limit);
    if (clamped !== value) (out ??= { ...params })[key] = clamped;
  }
  return out ?? params;
}

/** The limit for an animation path ("transform.positionX", "params.sides", "effects.<id>.params.intensity"); null if unbounded. */
export function limitForPath(element: Parameters<typeof limitsForElement>[0] & { effects?: Effect[] }, path: string): NumberLimit | null {
  const effect = /^effects\.([^.]+)\.params\.(.+)$/.exec(path);
  if (effect) {
    const found = element.effects?.find((e) => e.id === effect[1]);
    return found ? (limitsForEffect(found)[effect[2] as string] ?? null) : null;
  }
  const key = path.startsWith("params.") ? path.slice("params.".length) : path;
  return limitsForElement(element)[key] ?? null;
}

/** Clamps `params`, `effects[].params` and `masks[].params` of an element against their definitions. */
export function clampElementParams<T extends TimelineElement>(element: T): T {
  const decorated = element as T & { effects?: Effect[]; masks?: Mask[] };
  let params = clampParams(element.params, limitsForElement(element));
  const family = params[PARAM.fontFamily];
  if (element.type === "text" && typeof family === "string" && !isSafeFontFamily(family)) {
    params = { ...params, [PARAM.fontFamily]: DEFAULT_FONT_FAMILY };
  }
  let effects = decorated.effects;
  let masks = decorated.masks;
  if (effects) {
    const next = effects.map((e) => {
      const p = clampParams(e.params, limitsForEffect(e));
      return p === e.params ? e : { ...e, params: p };
    });
    if (next.some((e, i) => e !== effects?.[i])) effects = next;
  }
  if (masks) {
    const next = masks.map((m) => {
      const p = clampParams(m.params, limitsForMask(m));
      return p === m.params ? m : { ...m, params: p };
    });
    if (next.some((m, i) => m !== masks?.[i])) masks = next;
  }
  if (params === element.params && effects === decorated.effects && masks === decorated.masks) return element;
  const out = { ...element, params } as T & { effects?: Effect[]; masks?: Mask[] };
  if (effects) out.effects = effects;
  if (masks) out.masks = masks;
  return out;
}
