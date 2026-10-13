import { mediaTime, type MediaTime } from "#/engine/time";
import {
  PARAM, numberParam, type ElementAnimations, type IdGenerator, type ParamValues, type TextAnimationSpec, type TextAnimationState,
} from "#/engine/model";
import { removePathAnimation, upsertKeyframe } from "./mutate";

/** Parameters whose keyframes belong to the text animation presets; setting a preset rewrites exactly these. */
export const TEXT_ANIMATION_PATHS = [PARAM.opacity, PARAM.positionY, PARAM.scaleX, PARAM.scaleY, PARAM.reveal, PARAM.blur, PARAM.wordReveal, PARAM.countValue] as const;

/** How far a slide travels, as a fraction of the canvas height. */
export const SLIDE_DISTANCE_FRACTION = 0.08;
const POP_FROM = 0.5;
const POP_OVERSHOOT = 1.1;
/** Blur strength (0-100 scale of the blur effect) text starts from when it blurs in and ends at when it blurs out. */
export const BLUR_PRESET_INTENSITY = 40;
/** The blur-in rise is a hint of motion, not a full slide. */
const BLUR_SLIDE_SHARE = 0.4;
/** Count-up keys follow an ease-out curve sampled at these fractions of the phase (keyframes are linear between them). */
const COUNT_EASE_SAMPLES = [0, 0.2, 0.4, 0.6, 0.8, 1] as const;

export interface PresetKey { time: number; value: number }
export type PresetKeys = Partial<Record<(typeof TEXT_ANIMATION_PATHS)[number], PresetKey[]>>;

interface Base { opacity: number; positionY: number; scaleX: number; scaleY: number; slide: number; blur: number; count: number }

/** Keys for the phase that ends at `D` after `origin` (in) or starts at `origin` and ends at `origin + D` (out). */
function phaseKeys(input: { spec: TextAnimationSpec; phase: "in" | "out"; origin: number; base: Base }): PresetKeys {
  const { phase, origin, base } = input;
  const D = input.spec.duration;
  const at = (fraction: number): number => origin + Math.round(D * fraction);
  const isIn = phase === "in";
  switch (input.spec.preset) {
    case "fade":
      return { [PARAM.opacity]: isIn ? [{ time: at(0), value: 0 }, { time: at(1), value: base.opacity }] : [{ time: at(0), value: base.opacity }, { time: at(1), value: 0 }] };
    case "slide-up":
      return isIn
        ? {
          [PARAM.positionY]: [{ time: at(0), value: base.positionY + base.slide }, { time: at(1), value: base.positionY }],
          [PARAM.opacity]: [{ time: at(0), value: 0 }, { time: at(1), value: base.opacity }],
        }
        : {
          [PARAM.positionY]: [{ time: at(0), value: base.positionY }, { time: at(1), value: base.positionY - base.slide }],
          [PARAM.opacity]: [{ time: at(0), value: base.opacity }, { time: at(1), value: 0 }],
        };
    case "pop": {
      const scale = (value: number): PresetKey[] => isIn
        ? [{ time: at(0), value: value * POP_FROM }, { time: at(0.7), value: value * POP_OVERSHOOT }, { time: at(1), value }]
        : [{ time: at(0), value }, { time: at(0.3), value: value * POP_OVERSHOOT }, { time: at(1), value: value * POP_FROM }];
      return {
        [PARAM.scaleX]: scale(base.scaleX),
        [PARAM.scaleY]: scale(base.scaleY),
        [PARAM.opacity]: isIn ? [{ time: at(0), value: 0 }, { time: at(0.4), value: base.opacity }] : [{ time: at(0.6), value: base.opacity }, { time: at(1), value: 0 }],
      };
    }
    case "blur-in":
      return isIn
        ? {
          [PARAM.blur]: [{ time: at(0), value: BLUR_PRESET_INTENSITY }, { time: at(1), value: base.blur }],
          [PARAM.opacity]: [{ time: at(0), value: 0 }, { time: at(0.7), value: base.opacity }],
          [PARAM.positionY]: [{ time: at(0), value: base.positionY + base.slide * BLUR_SLIDE_SHARE }, { time: at(1), value: base.positionY }],
        }
        : {
          [PARAM.blur]: [{ time: at(0), value: base.blur }, { time: at(1), value: BLUR_PRESET_INTENSITY }],
          [PARAM.opacity]: [{ time: at(0.3), value: base.opacity }, { time: at(1), value: 0 }],
        };
    case "stagger-words":
      return { [PARAM.wordReveal]: isIn ? [{ time: at(0), value: 0 }, { time: at(1), value: 1 }] : [{ time: at(0), value: 1 }, { time: at(1), value: 0 }] };
    case "count-up": {
      const samples = COUNT_EASE_SAMPLES.map((fraction) => ({ fraction, share: 1 - (1 - fraction) ** 3 }));
      return {
        [PARAM.countValue]: isIn
          ? samples.map(({ fraction, share }) => ({ time: at(fraction), value: base.count * share }))
          : samples.map(({ fraction, share }) => ({ time: at(fraction), value: base.count * (1 - share) })),
      };
    }
    case "typewriter":
    case "type-caret":
      return { [PARAM.reveal]: isIn ? [{ time: at(0), value: 0 }, { time: at(1), value: 1 }] : [{ time: at(0), value: 1 }, { time: at(1), value: 0 }] };
  }
}

/** Longest in or out phase: half of the clip, so the two never overlap. */
export const maxTextAnimationDuration = (clipDuration: number): number => Math.floor(clipDuration / 2);

/** Every keyframe the in and out presets of `state` produce on a clip of `clipDuration`, merged per path in time order. */
export function textAnimationKeys(input: { state: TextAnimationState; clipDuration: number; params: ParamValues; canvasHeight: number }): PresetKeys {
  const base: Base = {
    opacity: numberParam(input.params, PARAM.opacity, 1),
    positionY: numberParam(input.params, PARAM.positionY, 0),
    scaleX: numberParam(input.params, PARAM.scaleX, 1),
    scaleY: numberParam(input.params, PARAM.scaleY, 1),
    slide: input.canvasHeight * SLIDE_DISTANCE_FRACTION,
    blur: numberParam(input.params, PARAM.blur, 0),
    count: numberParam(input.params, PARAM.countValue, 0),
  };
  const limit = maxTextAnimationDuration(input.clipDuration);
  const merged: PresetKeys = {};
  const add = (keys: PresetKeys): void => {
    for (const path of TEXT_ANIMATION_PATHS) {
      const list = keys[path];
      if (list) merged[path] = [...(merged[path] ?? []), ...list];
    }
  };
  if (input.state.in) {
    const spec = { ...input.state.in, duration: mediaTime(Math.min(input.state.in.duration, limit)) };
    add(phaseKeys({ spec, phase: "in", origin: 0, base }));
  }
  if (input.state.out) {
    const duration = Math.min(input.state.out.duration, limit);
    add(phaseKeys({ spec: { ...input.state.out, duration: mediaTime(duration) }, phase: "out", origin: input.clipDuration - duration, base }));
  }
  for (const path of TEXT_ANIMATION_PATHS) merged[path]?.sort((a, b) => a.time - b.time);
  return merged;
}

/** Replaces the preset-owned animation paths with the keys of `state`, leaving every other animated path alone. */
export function applyTextAnimation(input: {
  animations: ElementAnimations | undefined; state: TextAnimationState; clipDuration: number; params: ParamValues; canvasHeight: number; newId: IdGenerator;
}): ElementAnimations | undefined {
  let animations = input.animations;
  for (const path of TEXT_ANIMATION_PATHS) animations = removePathAnimation(animations, path);
  const keys = textAnimationKeys(input);
  for (const path of TEXT_ANIMATION_PATHS) {
    for (const key of keys[path] ?? []) {
      animations = upsertKeyframe({ animations, path, time: mediaTime(Math.min(Math.max(0, key.time), input.clipDuration)) as MediaTime, value: key.value, newId: input.newId });
    }
  }
  return animations;
}
