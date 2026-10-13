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
  /** "clip" effects read the clip's own pixels (keying, segmentation) and make no sense as a scene-wide effect layer. */
  scope?: "clip";
}

const adjustNumber = (key: string, label: string, min: number, max: number): ParamDef =>
  ({ type: "number", key, label, default: 0, min, max, step: 1 });

export const EFFECT_DEFINITIONS: Record<string, EffectDefinition> = {
  adjust: {
    type: "adjust",
    name: "Colour adjust",
    params: [
      adjustNumber("brightness", "Brightness", -100, 100),
      adjustNumber("contrast", "Contrast", -100, 100),
      adjustNumber("saturation", "Saturation", -100, 100),
      adjustNumber("exposure", "Exposure", -100, 100),
      adjustNumber("temperature", "Temperature", -100, 100),
      adjustNumber("tint", "Tint", -100, 100),
      adjustNumber("vignette", "Vignette", 0, 100),
      adjustNumber("sharpen", "Sharpen", 0, 100),
    ],
  },
  blur: {
    type: "blur",
    name: "Blur",
    params: [{ type: "number", key: "intensity", label: "Intensity", default: 15, min: 0, max: 100, step: 1 }],
  },
  "chroma-key": {
    type: "chroma-key",
    name: "Chroma key",
    scope: "clip",
    params: [
      { type: "color", key: "keyColor", label: "Key colour", default: "#00ff00" },
      { type: "number", key: "similarity", label: "Similarity", default: 30, min: 0, max: 100, step: 1 },
      { type: "number", key: "smoothness", label: "Edge smoothness", default: 10, min: 0, max: 100, step: 1 },
      { type: "number", key: "spill", label: "Spill suppression", default: 50, min: 0, max: 100, step: 1 },
    ],
  },
  "remove-background": {
    type: "remove-background",
    name: "Remove background",
    scope: "clip",
    params: [
      { type: "number", key: "softness", label: "Edge softness", default: 40, min: 0, max: 100, step: 1 },
      { type: "boolean", key: "invert", label: "Keep background instead", default: false },
    ],
  },
};

/** Effects that can be dropped on an empty area as a scene-wide effect layer. */
export const LAYER_EFFECT_TYPES: ReadonlyArray<string> = Object.values(EFFECT_DEFINITIONS).filter((d) => d.scope !== "clip").map((d) => d.type);

export type AdjustParams = Partial<Record<"brightness" | "contrast" | "saturation" | "exposure" | "temperature" | "tint" | "vignette" | "sharpen", number>>;

/** Named looks, expressed as `adjust` parameter bundles so they stay editable in the inspector. */
export const FILTER_PRESETS = {
  vivid: { name: "Vivid", params: { saturation: 40, contrast: 15, brightness: 5 } },
  mono: { name: "Mono", params: { saturation: -100, contrast: 10 } },
  warm: { name: "Warm", params: { temperature: 45, tint: 8, saturation: 8 } },
  cool: { name: "Cool", params: { temperature: -45, tint: -4, saturation: 5 } },
  fade: { name: "Fade", params: { contrast: -25, brightness: 10, saturation: -20 } },
  noir: { name: "Noir", params: { saturation: -100, contrast: 40, brightness: -10, vignette: 40 } },
  "teal-orange": { name: "Teal and orange", params: { temperature: 35, tint: -20, contrast: 15, saturation: 20 } },
  sepia: { name: "Sepia", params: { saturation: -100, temperature: 100, tint: 15, contrast: -10 } },
} as const satisfies Record<string, { name: string; params: AdjustParams }>;
export type FilterPresetId = keyof typeof FILTER_PRESETS;
export const FILTER_PRESET_IDS = Object.keys(FILTER_PRESETS) as FilterPresetId[];

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

export const CURSOR_STYLES = ["arrow", "hand", "dot"] as const;
export type CursorStyle = (typeof CURSOR_STYLES)[number];
export const WINDOW_FRAME_STYLES = ["mac", "browser", "plain"] as const;
export type WindowFrameStyle = (typeof WINDOW_FRAME_STYLES)[number];

const optionsOf = (values: ReadonlyArray<string>, labels: Record<string, string>): Array<{ value: string; label: string }> =>
  values.map((value) => ({ value, label: labels[value] ?? value }));

export interface GraphicDefinition {
  id: string;
  name: string;
  params: ReadonlyArray<ParamDef>;
  /**
   * Drawn at the size it ends up on screen instead of into a square that is then stretched, so corner radii, window
   * buttons and pointer shapes stay undistorted at any box size (the compositor passes the laid-out pixel size).
   */
  sized?: boolean;
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
  cursor: {
    id: "cursor", name: "Cursor", sized: true,
    params: [
      { type: "select", key: "style", label: "Style", default: "arrow", options: optionsOf(CURSOR_STYLES, { arrow: "Arrow", hand: "Hand", dot: "Touch dot" }) },
      { type: "color", key: "fill", label: "Fill", default: "#ffffff" },
      { type: "color", key: "stroke", label: "Outline", default: "#111111" },
      { type: "color", key: "rippleColor", label: "Click ripple", default: "#3b82f6" },
      { type: "number", key: "click", label: "Click", default: 0, min: 0, max: 1, step: 0.01 },
    ],
  },
  "window-frame": {
    id: "window-frame", name: "Window frame", sized: true,
    params: [
      { type: "select", key: "style", label: "Style", default: "mac", options: optionsOf(WINDOW_FRAME_STYLES, { mac: "Mac window", browser: "Browser", plain: "Plain card" }) },
      { type: "color", key: "fill", label: "Body", default: "#ffffff" },
      { type: "color", key: "barColor", label: "Title bar", default: "#ececf1" },
      { type: "color", key: "stroke", label: "Outline", default: "#d4d4dc" },
      { type: "number", key: "cornerRadius", label: "Corner radius", default: 12, min: 0, max: 50, step: 1 },
    ],
  },
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
