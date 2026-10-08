import {
  resolveColorAtTime, resolveDiscreteAtTime, resolveNumberAtTime, isColorPath,
} from "#/engine/animation";
import type { Effect, ParamValue, ParamValues, TimelineElement } from "#/engine/model";

const GRAPHIC_PARAM = /^params\.(.+)$/;
const EFFECT_PARAM = /^effects\.([^.]+)\.params\.(.+)$/;

type WithEffects = TimelineElement & { effects?: Effect[] };

export function effectParamPath(effectId: string, key: string): string {
  return `effects.${effectId}.params.${key}`;
}

export function getBaseValue(element: TimelineElement, path: string): ParamValue | undefined {
  const effect = EFFECT_PARAM.exec(path);
  if (effect) {
    const found = (element as WithEffects).effects?.find((e) => e.id === effect[1]);
    return found?.params[effect[2] as string];
  }
  const graphic = GRAPHIC_PARAM.exec(path);
  if (graphic) return element.params[graphic[1] as string];
  return element.params[path];
}

export function setBaseValue(element: TimelineElement, path: string, value: ParamValue): TimelineElement {
  const effect = EFFECT_PARAM.exec(path);
  if (effect) {
    const effects = (element as WithEffects).effects?.map((e) =>
      e.id === effect[1] ? { ...e, params: { ...e.params, [effect[2] as string]: value } } : e);
    return { ...element, effects } as TimelineElement;
  }
  const graphic = GRAPHIC_PARAM.exec(path);
  const key = graphic ? (graphic[1] as string) : path;
  return { ...element, params: { ...element.params, [key]: value } };
}

/** Animated value of one path at an element-local time, falling back to the static value. */
export function resolvePathValue(element: TimelineElement, path: string, localTime: number): ParamValue | undefined {
  const base = getBaseValue(element, path);
  if (base === undefined) return undefined;
  if (!element.animations?.[path]) return base;
  if (typeof base === "number") return resolveNumberAtTime(element.animations, path, localTime, base);
  if (isColorPath(path, base)) return resolveColorAtTime(element.animations, path, localTime, base as string);
  return resolveDiscreteAtTime(element.animations, path, localTime, base);
}

/** All params of an element with every animated path evaluated at `localTime`. */
export function resolveElementParams(element: TimelineElement, localTime: number): ParamValues {
  if (!element.animations) return element.params;
  const out: ParamValues = { ...element.params };
  for (const path of Object.keys(element.animations)) {
    if (path.startsWith("effects.")) continue;
    const key = GRAPHIC_PARAM.exec(path)?.[1] ?? path;
    const value = resolvePathValue(element, path, localTime);
    if (value !== undefined) out[key] = value;
  }
  return out;
}

export function resolveEffectParams(element: TimelineElement, effect: Effect, localTime: number): ParamValues {
  if (!element.animations) return effect.params;
  const out: ParamValues = { ...effect.params };
  for (const key of Object.keys(effect.params)) {
    const path = effectParamPath(effect.id, key);
    if (element.animations[path]) {
      const value = resolvePathValue(element, path, localTime);
      if (value !== undefined) out[key] = value;
    }
  }
  return out;
}
