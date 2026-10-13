import { addClipEffect, batch, removeClipEffect, updateClipEffectParams, type Command } from "#/engine/commands";
import {
  EFFECT_DEFINITIONS, FILTER_PRESETS, FILTER_PRESET_IDS, defaultsOf, type Effect, type ElementRef, type FilterPresetId, type ParamDef,
  type ParamValues, type TimelineElement,
} from "#/engine/model";
import { adjustPlan } from "#/engine/render";

export const ADJUST_DEFS: ReadonlyArray<ParamDef> = EFFECT_DEFINITIONS.adjust?.params ?? [];
export const NEUTRAL_ADJUST: ParamValues = defaultsOf(ADJUST_DEFS);

export const FILTER_LABELS: Record<FilterPresetId, string> = {
  vivid: "Vivid", mono: "Mono", warm: "Warm", cool: "Cool", fade: "Fade", noir: "Noir", "teal-orange": "Teal-Orange", sepia: "Sepia",
};
export { FILTER_PRESET_IDS };

export type PresetMatch = { kind: "none" } | { kind: "preset"; id: FilterPresetId; intensity: number } | { kind: "custom" };

export const adjustEffectOf = (element: TimelineElement): Effect | undefined =>
  (element as { effects?: Effect[] }).effects?.find((e) => e.type === "adjust");

/** The preset's parameters scaled the way the `apply_filter` agent tool scales them. */
export function scaledPreset(id: FilterPresetId, intensity: number): ParamValues {
  const out: ParamValues = {};
  for (const [key, value] of Object.entries(FILTER_PRESETS[id].params)) out[key] = Math.round(value * intensity) + 0;
  return out;
}

/** Intensities tried when recognising a look: every half percent. Several can give identical rounded values, so the match is the middle of that run (or 1 when the run reaches full strength). */
const INTENSITY_STEPS = 200;

const filled = (params: ParamValues | undefined): ParamValues => ({ ...NEUTRAL_ADJUST, ...params });

function sameAdjust(a: ParamValues, b: ParamValues): boolean {
  return ADJUST_DEFS.every((def) => (a[def.key] ?? def.default) === (b[def.key] ?? def.default));
}

/** Which named look (and at what strength) a set of adjust parameters is, if any; sliders that moved off a preset make it "custom". */
export function matchPreset(params: ParamValues | undefined): PresetMatch {
  const current = filled(params);
  if (sameAdjust(current, NEUTRAL_ADJUST)) return { kind: "none" };
  for (const id of FILTER_PRESET_IDS) {
    const preset: Record<string, number> = FILTER_PRESETS[id].params;
    const keys = Object.keys(preset);
    if (ADJUST_DEFS.some((d) => !keys.includes(d.key) && current[d.key] !== d.default)) continue;
    const fits: number[] = [];
    for (let step = 0; step <= INTENSITY_STEPS; step++) {
      const intensity = step / INTENSITY_STEPS;
      if (sameAdjust(current, filled(scaledPreset(id, intensity)))) fits.push(intensity);
    }
    const last = fits[fits.length - 1];
    if (last !== undefined) return { kind: "preset", id, intensity: last === 1 ? 1 : (fits[Math.floor(fits.length / 2)] as number) };
  }
  return { kind: "custom" };
}

/**
 * Sets adjust parameters on a clip the way `set_color_adjust` / `apply_filter` do: one adjust effect per clip, created on
 * first use. `reset` zeroes every key not in `values`. `effectId` must stay the same across the previews of one gesture.
 */
export function adjustCommand(input: { element: TimelineElement; ref: ElementRef; values: ParamValues; reset: boolean; effectId: string; label: string }): Command {
  const params = input.reset ? { ...NEUTRAL_ADJUST, ...input.values } : input.values;
  const existing = adjustEffectOf(input.element);
  if (existing) return batch(input.label, [updateClipEffectParams(input.ref, existing.id, params)]);
  return batch(input.label, [
    addClipEffect({ ref: input.ref, effectType: "adjust", effectId: input.effectId }),
    updateClipEffectParams(input.ref, input.effectId, params),
  ]);
}

/** Removes the clip's adjust effect (the "None" filter); null when there is nothing to clear. */
export function clearAdjustCommand(input: { element: TimelineElement; ref: ElementRef }): Command | null {
  const existing = adjustEffectOf(input.element);
  return existing ? batch("Clear filter", [removeClipEffect(input.ref, existing.id)]) : null;
}

export interface SwatchLook {
  filter: string;
  /** Translucent colour layers (temperature and tint casts) stacked over the picture. */
  cast: string;
  /** Radial darkening toward the corners, or "none". */
  vignette: string;
}

/** CSS for a mini preview of an adjust bundle, from the same plan the compositor renders. */
export function swatchLook(params: ParamValues): SwatchLook {
  const plan = adjustPlan(filled(params));
  if (!plan) return { filter: "none", cast: "none", vignette: "none" };
  const layers = plan.casts.map((c) => `linear-gradient(rgba(${c.r},${c.g},${c.b},${c.alpha}), rgba(${c.r},${c.g},${c.b},${c.alpha}))`);
  return {
    filter: plan.filter,
    cast: layers.length > 0 ? layers.join(", ") : "none",
    vignette: plan.vignette > 0 ? `radial-gradient(ellipse at center, transparent 45%, rgba(0,0,0,${plan.vignette}) 100%)` : "none",
  };
}
