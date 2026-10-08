import type { Effect, Mask, MaskType, ParamValue, ParamValues } from "./types";

export type ParamDef =
  | { type: "number"; key: string; label: string; default: number; min?: number; max?: number; step: number; unit?: string }
  | { type: "boolean"; key: string; label: string; default: boolean }
  | { type: "color"; key: string; label: string; default: string }
  | { type: "select"; key: string; label: string; default: string; options: ReadonlyArray<{ value: string; label: string }> };

export function defaultsOf(defs: ReadonlyArray<ParamDef>): ParamValues {
  return Object.fromEntries(defs.map((d) => [d.key, d.default as ParamValue]));
}

/** Coerce a user value to a legal one for the definition, or null when it cannot be. */
export function coerceParam(def: ParamDef, value: unknown): ParamValue | null {
  switch (def.type) {
    case "number": {
      if (typeof value !== "number" || !Number.isFinite(value)) return null;
      let v = value;
      if (def.step > 0) {
        const digits = (String(def.step).split(".")[1] ?? "").length;
        v = Number((Math.round(v / def.step) * def.step).toFixed(digits));
      }
      if (def.min !== undefined) v = Math.max(def.min, v);
      if (def.max !== undefined) v = Math.min(def.max, v);
      return v;
    }
    case "boolean": return typeof value === "boolean" ? value : null;
    case "color": return typeof value === "string" ? value : null;
    case "select": return typeof value === "string" && def.options.some((o) => o.value === value) ? value : null;
  }
}

// ---- Effects -------------------------------------------------------------------------------------------------

export interface EffectDefinition {
  type: string;
  name: string;
  params: ReadonlyArray<ParamDef>;
}

export const EFFECT_DEFINITIONS: Record<string, EffectDefinition> = {
  blur: {
    type: "blur",
    name: "Blur",
    params: [{ type: "number", key: "intensity", label: "Intensity", default: 15, min: 0, max: 100, step: 1 }],
  },
};

export function getEffectDefinition(type: string): EffectDefinition | undefined {
  return EFFECT_DEFINITIONS[type];
}

export function buildDefaultEffect(type: string, id: string): Effect {
  const def = getEffectDefinition(type);
  if (!def) throw new Error(`Unknown effect type "${type}"`);
  return { id, type, params: defaultsOf(def.params), enabled: true };
}

// ---- Graphics ------------------------------------------------------------------------------------------------

export const STROKE_PARAMS: ReadonlyArray<ParamDef> = [
  { type: "color", key: "fill", label: "Fill", default: "#ffffff" },
  { type: "color", key: "stroke", label: "Stroke", default: "#000000" },
  { type: "number", key: "strokeWidth", label: "Stroke width", default: 0, min: 0, max: 64, step: 1 },
  { type: "select", key: "strokeAlign", label: "Stroke align", default: "center",
    options: [{ value: "inside", label: "Inside" }, { value: "center", label: "Center" }, { value: "outside", label: "Outside" }] },
];

export interface GraphicDefinition {
  id: string;
  name: string;
  params: ReadonlyArray<ParamDef>;
}

export const GRAPHIC_DEFINITIONS: Record<string, GraphicDefinition> = {
  rectangle: { id: "rectangle", name: "Rectangle", params: [...STROKE_PARAMS, { type: "number", key: "cornerRadius", label: "Corner radius", default: 0, min: 0, max: 50, step: 1 }] },
  ellipse: { id: "ellipse", name: "Ellipse", params: [...STROKE_PARAMS] },
  polygon: { id: "polygon", name: "Polygon", params: [
    ...STROKE_PARAMS,
    { type: "number", key: "sides", label: "Sides", default: 5, min: 3, max: 12, step: 1 },
    { type: "number", key: "cornerRadius", label: "Corner radius", default: 0, min: 0, max: 50, step: 1 },
  ] },
  star: { id: "star", name: "Star", params: [
    ...STROKE_PARAMS,
    { type: "number", key: "points", label: "Points", default: 5, min: 3, max: 12, step: 1 },
    { type: "number", key: "depth", label: "Depth", default: 45, min: 1, max: 99, step: 1 },
  ] },
};

export const DEFAULT_GRAPHIC_SOURCE_SIZE = 512;

// ---- Masks ---------------------------------------------------------------------------------------------------

export const MASK_BASE_PARAMS: ReadonlyArray<ParamDef> = [
  { type: "number", key: "feather", label: "Feather", default: 0, min: 0, max: 1000, step: 1 },
  { type: "boolean", key: "inverted", label: "Invert", default: false },
  { type: "color", key: "strokeColor", label: "Stroke color", default: "#ffffff" },
  { type: "number", key: "strokeWidth", label: "Stroke width", default: 0, min: 0, max: 100, step: 1 },
  { type: "select", key: "strokeAlign", label: "Stroke align", default: "center",
    options: [{ value: "inside", label: "Inside" }, { value: "center", label: "Center" }, { value: "outside", label: "Outside" }] },
];

const BOX_PARAMS: ReadonlyArray<ParamDef> = [
  { type: "number", key: "centerX", label: "X", default: 0, min: -1, max: 1, step: 0.01 },
  { type: "number", key: "centerY", label: "Y", default: 0, min: -1, max: 1, step: 0.01 },
  { type: "number", key: "width", label: "Width", default: 0.6, min: 0.01, max: 4, step: 0.01 },
  { type: "number", key: "height", label: "Height", default: 0.6, min: 0.01, max: 4, step: 0.01 },
  { type: "number", key: "rotation", label: "Rotation", default: 0, min: 0, max: 360, step: 1 },
];

export interface MaskDefinition {
  type: MaskType;
  name: string;
  params: ReadonlyArray<ParamDef>;
}

export const MASK_DEFINITIONS: Record<MaskType, MaskDefinition> = {
  split: { type: "split", name: "Split", params: [
    ...MASK_BASE_PARAMS,
    { type: "number", key: "centerX", label: "X", default: 0, min: -1, max: 1, step: 0.01 },
    { type: "number", key: "centerY", label: "Y", default: 0, min: -1, max: 1, step: 0.01 },
    { type: "number", key: "rotation", label: "Rotation", default: 0, min: 0, max: 360, step: 1 },
  ] },
  "cinematic-bars": { type: "cinematic-bars", name: "Cinematic bars", params: [...MASK_BASE_PARAMS, ...BOX_PARAMS] },
  rectangle: { type: "rectangle", name: "Rectangle", params: [...MASK_BASE_PARAMS, ...BOX_PARAMS] },
  ellipse: { type: "ellipse", name: "Ellipse", params: [...MASK_BASE_PARAMS, ...BOX_PARAMS] },
  heart: { type: "heart", name: "Heart", params: [...MASK_BASE_PARAMS, ...BOX_PARAMS] },
  diamond: { type: "diamond", name: "Diamond", params: [...MASK_BASE_PARAMS, ...BOX_PARAMS] },
  star: { type: "star", name: "Star", params: [...MASK_BASE_PARAMS, ...BOX_PARAMS] },
};

export function buildDefaultMask(type: MaskType, id: string): Mask {
  return { id, type, params: defaultsOf(MASK_DEFINITIONS[type].params) };
}
