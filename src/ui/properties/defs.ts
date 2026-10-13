import {
  BLEND_MODES, ELEMENT_NUMBER_LIMITS, PARAM, TEXT_NUMBER_LIMITS, VOLUME_DB_MAX, VOLUME_DB_MIN, type NumberLimit, type ParamDef, type ParamValues,
} from "#/engine/model";
import type { IconName } from "../icons";

interface FieldExtras {
  keyframable?: boolean;
  icon?: IconName;
  displayMultiplier?: number;
  suffix?: string;
  showWhen?: (params: ParamValues) => boolean;
  /** Render a number as a range slider plus readout; `sliderMin`/`sliderMax` narrow the range below the engine's hard limits. */
  control?: "slider";
  sliderMin?: number;
  sliderMax?: number;
}

export type TextFieldDef = { type: "text"; key: string; label: string; default: string; widget: "textarea" | "font" };
export type FieldDef = (ParamDef | TextFieldDef) & FieldExtras;

/** Number fields get the same hard bounds the engine enforces, so the inspector never offers a value the engine would clamp. */
function bounded(fields: FieldDef[], limits: Readonly<Record<string, NumberLimit>>): FieldDef[] {
  return fields.map((f) => {
    const limit = f.type === "number" ? limits[f.key] : undefined;
    return f.type === "number" && limit ? { ...f, min: limit.min, max: limit.max } : f;
  });
}

const BLEND_LABELS: Record<string, string> = {
  normal: "Normal", darken: "Darken", multiply: "Multiply", "color-burn": "Color burn", lighten: "Lighten", screen: "Screen",
  "plus-lighter": "Plus lighter", "color-dodge": "Color dodge", overlay: "Overlay", "soft-light": "Soft light", "hard-light": "Hard light",
  difference: "Difference", exclusion: "Exclusion", hue: "Hue", saturation: "Saturation", color: "Color", luminosity: "Luminosity",
};

export const TRANSFORM_FIELDS: FieldDef[] = bounded([
  { type: "number", key: PARAM.positionX, label: "Position X", default: 0, min: -100000, step: 1, keyframable: true, icon: "move" },
  { type: "number", key: PARAM.positionY, label: "Position Y", default: 0, min: -100000, step: 1, keyframable: true, icon: "move" },
  { type: "number", key: PARAM.scaleX, label: "Scale X", default: 1, min: 0.01, step: 0.01, keyframable: true, icon: "zoom-in", displayMultiplier: 100, suffix: "%" },
  { type: "number", key: PARAM.scaleY, label: "Scale Y", default: 1, min: 0.01, step: 0.01, keyframable: true, icon: "zoom-in", displayMultiplier: 100, suffix: "%" },
  { type: "number", key: PARAM.rotate, label: "Rotation", default: 0, min: -360, max: 360, step: 1, keyframable: true, icon: "rotate", suffix: "°" },
], ELEMENT_NUMBER_LIMITS);

export const BLEND_FIELDS: FieldDef[] = bounded([
  { type: "number", key: PARAM.opacity, label: "Opacity", default: 1, min: 0, max: 1, step: 0.01, keyframable: true, icon: "droplet", displayMultiplier: 100, suffix: "%" },
  { type: "select", key: PARAM.blendMode, label: "Blend mode", default: "normal", options: BLEND_MODES.map((m) => ({ value: m, label: BLEND_LABELS[m] ?? m })) },
], ELEMENT_NUMBER_LIMITS);

export const AUDIO_FIELDS: FieldDef[] = bounded([
  { type: "number", key: PARAM.volume, label: "Volume", default: 0, min: VOLUME_DB_MIN, max: VOLUME_DB_MAX, step: 0.01, keyframable: true, icon: "volume", suffix: "dB" },
  { type: "boolean", key: PARAM.muted, label: "Muted", default: false },
  { type: "number", key: PARAM.denoise, label: "Noise removal", default: 0, min: 0, max: 1, step: 0.01, keyframable: false, control: "slider", displayMultiplier: 100, suffix: "%" },
], ELEMENT_NUMBER_LIMITS);

const bgOn = (p: ParamValues): boolean => p[PARAM.bgEnabled] === true;

export const TEXT_FIELDS: FieldDef[] = bounded([
  { type: "text", key: PARAM.content, label: "Content", default: "", widget: "textarea" },
  { type: "text", key: PARAM.fontFamily, label: "Font family", default: "Arial", widget: "font" },
  { type: "number", key: PARAM.fontSize, label: "Font size", default: 15, min: 1, step: 1, icon: "type" },
  { type: "color", key: PARAM.color, label: "Color", default: "#ffffff", keyframable: true },
  { type: "select", key: PARAM.textAlign, label: "Text align", default: "center", options: [{ value: "left", label: "Left" }, { value: "center", label: "Center" }, { value: "right", label: "Right" }] },
  { type: "select", key: PARAM.fontWeight, label: "Font weight", default: "normal", options: [{ value: "normal", label: "Normal" }, { value: "bold", label: "Bold" }] },
  { type: "select", key: PARAM.fontStyle, label: "Font style", default: "normal", options: [{ value: "normal", label: "Normal" }, { value: "italic", label: "Italic" }] },
  { type: "select", key: PARAM.textDecoration, label: "Decoration", default: "none", options: [{ value: "none", label: "None" }, { value: "underline", label: "Underline" }, { value: "line-through", label: "Line through" }] },
  { type: "number", key: PARAM.letterSpacing, label: "Letter spacing", default: 0, min: -100, step: 0.1 },
  { type: "number", key: PARAM.lineHeight, label: "Line height", default: 1.2, min: 0.1, step: 0.1 },
  { type: "boolean", key: PARAM.bgEnabled, label: "Background", default: false },
  { type: "color", key: PARAM.bgColor, label: "Background color", default: "#000000", keyframable: true, showWhen: bgOn },
  { type: "number", key: PARAM.bgCornerRadius, label: "Radius", default: 0, min: 0, max: 100, step: 1, keyframable: true, showWhen: bgOn },
  { type: "number", key: PARAM.bgPaddingX, label: "Padding X", default: 30, min: 0, step: 1, keyframable: true, showWhen: bgOn },
  { type: "number", key: PARAM.bgPaddingY, label: "Padding Y", default: 42, min: 0, step: 1, keyframable: true, showWhen: bgOn },
  { type: "number", key: PARAM.bgOffsetX, label: "Offset X", default: 0, min: -100000, step: 1, keyframable: true, showWhen: bgOn },
  { type: "number", key: PARAM.bgOffsetY, label: "Offset Y", default: 0, min: -100000, step: 1, keyframable: true, showWhen: bgOn },
], TEXT_NUMBER_LIMITS);

const shadowOn = (p: ParamValues): boolean => p[PARAM.shadowEnabled] === true;

/** Crop edges are fractions of the source removed from each side (the engine caps them at 0.95). */
export const CROP_FIELDS: FieldDef[] = bounded([
  { type: "number", key: PARAM.cropLeft, label: "Crop left", default: 0, min: 0, max: 0.95, step: 0.01, keyframable: true, control: "slider", displayMultiplier: 100, suffix: "%" },
  { type: "number", key: PARAM.cropTop, label: "Crop top", default: 0, min: 0, max: 0.95, step: 0.01, keyframable: true, control: "slider", displayMultiplier: 100, suffix: "%" },
  { type: "number", key: PARAM.cropRight, label: "Crop right", default: 0, min: 0, max: 0.95, step: 0.01, keyframable: true, control: "slider", displayMultiplier: 100, suffix: "%" },
  { type: "number", key: PARAM.cropBottom, label: "Crop bottom", default: 0, min: 0, max: 0.95, step: 0.01, keyframable: true, control: "slider", displayMultiplier: 100, suffix: "%" },
], ELEMENT_NUMBER_LIMITS);

export const STROKE_FIELDS: FieldDef[] = bounded([
  { type: "number", key: PARAM.strokeWidth, label: "Stroke width", default: 0, min: 0, step: 0.5, keyframable: true, control: "slider", sliderMax: 40 },
  { type: "color", key: PARAM.strokeColor, label: "Stroke color", default: "#000000", keyframable: true },
], TEXT_NUMBER_LIMITS);

export const SHADOW_FIELDS: FieldDef[] = bounded([
  { type: "boolean", key: PARAM.shadowEnabled, label: "Shadow", default: false },
  { type: "color", key: PARAM.shadowColor, label: "Shadow color", default: "#000000b3", keyframable: true, showWhen: shadowOn },
  { type: "number", key: PARAM.shadowBlur, label: "Shadow blur", default: 8, min: 0, step: 1, keyframable: true, control: "slider", sliderMax: 50, showWhen: shadowOn },
  { type: "number", key: PARAM.shadowOffsetX, label: "Shadow offset X", default: 4, step: 1, keyframable: true, control: "slider", sliderMin: -50, sliderMax: 50, showWhen: shadowOn },
  { type: "number", key: PARAM.shadowOffsetY, label: "Shadow offset Y", default: 4, step: 1, keyframable: true, control: "slider", sliderMin: -50, sliderMax: 50, showWhen: shadowOn },
], TEXT_NUMBER_LIMITS);

export const MASK_LABELS: Record<string, string> = {
  rectangle: "Rectangle", ellipse: "Ellipse", diamond: "Diamond", heart: "Heart", star: "Star", split: "Split", "cinematic-bars": "Cinematic bars",
};
