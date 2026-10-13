import type { ParamValues } from "./types";

export const PARAM = {
  opacity: "opacity",
  blendMode: "blendMode",
  positionX: "transform.positionX",
  positionY: "transform.positionY",
  scaleX: "transform.scaleX",
  scaleY: "transform.scaleY",
  rotate: "transform.rotate",
  volume: "volume",
  muted: "muted",
  /** Noise removal strength 0-1 on clips with audio; absent means 0 (off). */
  denoise: "denoise",
  content: "content",
  fontSize: "fontSize",
  fontFamily: "fontFamily",
  color: "color",
  textAlign: "textAlign",
  fontWeight: "fontWeight",
  fontStyle: "fontStyle",
  textDecoration: "textDecoration",
  letterSpacing: "letterSpacing",
  lineHeight: "lineHeight",
  bgEnabled: "background.enabled",
  bgColor: "background.color",
  bgCornerRadius: "background.cornerRadius",
  bgPaddingX: "background.paddingX",
  bgPaddingY: "background.paddingY",
  bgOffsetX: "background.offsetX",
  bgOffsetY: "background.offsetY",
  strokeWidth: "stroke.width",
  strokeColor: "stroke.color",
  shadowEnabled: "shadow.enabled",
  shadowColor: "shadow.color",
  shadowBlur: "shadow.blur",
  shadowOffsetX: "shadow.offsetX",
  shadowOffsetY: "shadow.offsetY",
  cropLeft: "crop.left",
  cropTop: "crop.top",
  cropRight: "crop.right",
  cropBottom: "crop.bottom",
  /** Fraction of the characters shown, 0..1 (typewriter animation). */
  reveal: "reveal",
} as const;

export const BLEND_MODES = [
  "normal", "darken", "multiply", "color-burn", "lighten", "screen", "plus-lighter", "color-dodge",
  "overlay", "soft-light", "hard-light", "difference", "exclusion", "hue", "saturation", "color", "luminosity",
] as const;
export type BlendMode = (typeof BLEND_MODES)[number];

export const VOLUME_DB_MIN = -60;
export const VOLUME_DB_MAX = 20;
export const RETIME_MIN = 0.01;
export const RETIME_MAX = 5;
export const SPEED_CURVE_MAX_POINTS = 6;
export const DEFAULT_NEW_ELEMENT_SECONDS = 5;
/** Text font size is expressed against a 90 unit tall canvas (size 15 on 1080p => 180px). */
export const TEXT_SIZE_REFERENCE_HEIGHT = 90;

export const TRANSFORM_DEFAULTS: ParamValues = {
  [PARAM.positionX]: 0,
  [PARAM.positionY]: 0,
  [PARAM.scaleX]: 1,
  [PARAM.scaleY]: 1,
  [PARAM.rotate]: 0,
  [PARAM.opacity]: 1,
  [PARAM.blendMode]: "normal",
};

export const TEXT_DEFAULTS: ParamValues = {
  ...TRANSFORM_DEFAULTS,
  [PARAM.content]: "Default text",
  [PARAM.fontSize]: 15,
  [PARAM.fontFamily]: "Arial",
  [PARAM.color]: "#ffffff",
  [PARAM.textAlign]: "center",
  [PARAM.fontWeight]: "normal",
  [PARAM.fontStyle]: "normal",
  [PARAM.textDecoration]: "none",
  [PARAM.letterSpacing]: 0,
  [PARAM.lineHeight]: 1.2,
  [PARAM.bgEnabled]: false,
  [PARAM.bgColor]: "#000000",
  [PARAM.bgCornerRadius]: 0,
  [PARAM.bgPaddingX]: 30,
  [PARAM.bgPaddingY]: 42,
  [PARAM.bgOffsetX]: 0,
  [PARAM.bgOffsetY]: 0,
  [PARAM.strokeWidth]: 0,
  [PARAM.strokeColor]: "#000000",
  [PARAM.shadowEnabled]: false,
  [PARAM.shadowColor]: "#000000b3",
  [PARAM.shadowBlur]: 8,
  [PARAM.shadowOffsetX]: 4,
  [PARAM.shadowOffsetY]: 4,
  [PARAM.reveal]: 1,
};

/** Crop edges are fractions (0-1) of the source removed from each side before the transform; the rest stays in place. */
export const CROP_DEFAULTS: ParamValues = {
  [PARAM.cropLeft]: 0,
  [PARAM.cropTop]: 0,
  [PARAM.cropRight]: 0,
  [PARAM.cropBottom]: 0,
};
export const CROP_MAX_EDGE = 0.95;

export const AUDIO_DEFAULTS: ParamValues = { [PARAM.volume]: 0, [PARAM.muted]: false };
export const VIDEO_DEFAULTS: ParamValues = { ...TRANSFORM_DEFAULTS, ...CROP_DEFAULTS, ...AUDIO_DEFAULTS };
export const IMAGE_DEFAULTS: ParamValues = { ...TRANSFORM_DEFAULTS, ...CROP_DEFAULTS };

export function numberParam(params: ParamValues, key: string, fallback: number): number {
  const value = params[key];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export function stringParam(params: ParamValues, key: string, fallback: string): string {
  const value = params[key];
  return typeof value === "string" ? value : fallback;
}

export function boolParam(params: ParamValues, key: string, fallback: boolean): boolean {
  const value = params[key];
  return typeof value === "boolean" ? value : fallback;
}

export function clampDb(db: number): number {
  return Math.min(VOLUME_DB_MAX, Math.max(VOLUME_DB_MIN, db));
}

export function dbToLinear(db: number): number {
  return 10 ** (db / 20);
}

export function clampRate(rate: number): number {
  if (!Number.isFinite(rate) || rate <= 0) return 1;
  return Math.min(RETIME_MAX, Math.max(RETIME_MIN, rate));
}
