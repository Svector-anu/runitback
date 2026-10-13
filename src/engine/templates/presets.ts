import { PARAM, type ParamValues } from "#/engine/model";
import type { TemplateAspect } from "./types";

/** Canvas size per aspect label; the same sizes as the editor's canvas presets. */
export const ASPECT_SIZES: Readonly<Record<TemplateAspect, { width: number; height: number }>> = {
  "16:9": { width: 1920, height: 1080 },
  "9:16": { width: 1080, height: 1920 },
  "1:1": { width: 1080, height: 1080 },
  "4:3": { width: 1440, height: 1080 },
};

/**
 * Text looks a template can name. `sizePx` is the font size in canvas pixels, so a preset reads the same on every
 * canvas; the planner converts it to the editor's relative `fontSize`. Every other key is a real text param. Background
 * padding keys are measured at a 180 px font and scale with the text.
 */
export interface TextStylePreset {
  sizePx: number;
  params: ParamValues;
}

const WHITE = "#ffffff";
const SHADOW = { [PARAM.shadowEnabled]: true, [PARAM.shadowColor]: "#000000b3", [PARAM.shadowBlur]: 10, [PARAM.shadowOffsetX]: 0, [PARAM.shadowOffsetY]: 4 } as const;

export const TEXT_STYLE_PRESETS: Readonly<Record<string, TextStylePreset>> = {
  display: {
    sizePx: 190,
    params: { [PARAM.fontFamily]: "Inter", [PARAM.fontWeight]: "bold", [PARAM.color]: WHITE, [PARAM.lineHeight]: 1.05, [PARAM.letterSpacing]: -2, ...SHADOW },
  },
  headline: {
    sizePx: 110,
    params: { [PARAM.fontFamily]: "Inter", [PARAM.fontWeight]: "bold", [PARAM.color]: WHITE, [PARAM.lineHeight]: 1.1, [PARAM.letterSpacing]: -1, ...SHADOW },
  },
  subhead: {
    sizePx: 60,
    params: { [PARAM.fontFamily]: "Inter", [PARAM.fontWeight]: "normal", [PARAM.color]: "#d7dbea", [PARAM.lineHeight]: 1.25, ...SHADOW },
  },
  kicker: {
    sizePx: 44,
    params: { [PARAM.fontFamily]: "Inter", [PARAM.fontWeight]: "bold", [PARAM.color]: "#9db4ff", [PARAM.letterSpacing]: 8, [PARAM.lineHeight]: 1.2 },
  },
  callout: {
    sizePx: 52,
    params: {
      [PARAM.fontFamily]: "Inter", [PARAM.fontWeight]: "bold", [PARAM.color]: WHITE, [PARAM.lineHeight]: 1.15,
      [PARAM.bgEnabled]: true, [PARAM.bgColor]: "#5b6cff", [PARAM.bgCornerRadius]: 30, [PARAM.bgPaddingX]: 130, [PARAM.bgPaddingY]: 62,
    },
  },
  label: {
    sizePx: 52,
    params: {
      [PARAM.fontFamily]: "Inter", [PARAM.fontWeight]: "bold", [PARAM.color]: "#101322", [PARAM.letterSpacing]: 3,
      [PARAM.bgEnabled]: true, [PARAM.bgColor]: "#ffffff", [PARAM.bgCornerRadius]: 100, [PARAM.bgPaddingX]: 150, [PARAM.bgPaddingY]: 80,
    },
  },
  quote: {
    sizePx: 78,
    params: { [PARAM.fontFamily]: "Georgia", [PARAM.fontWeight]: "normal", [PARAM.fontStyle]: "italic", [PARAM.color]: WHITE, [PARAM.lineHeight]: 1.25, ...SHADOW },
  },
  attribution: {
    sizePx: 46,
    params: { [PARAM.fontFamily]: "Inter", [PARAM.fontWeight]: "bold", [PARAM.color]: "#ffd166", [PARAM.letterSpacing]: 4, [PARAM.lineHeight]: 1.3 },
  },
  numeral: {
    sizePx: 300,
    params: { [PARAM.fontFamily]: "Inter", [PARAM.fontWeight]: "bold", [PARAM.color]: WHITE, [PARAM.lineHeight]: 1, [PARAM.letterSpacing]: -6, ...SHADOW },
  },
  caption: {
    sizePx: 64,
    params: {
      [PARAM.fontFamily]: "Inter", [PARAM.fontWeight]: "bold", [PARAM.color]: WHITE, [PARAM.lineHeight]: 1.2,
      [PARAM.strokeWidth]: 4, [PARAM.strokeColor]: "#000000", ...SHADOW,
    },
  },
  "title-bar": {
    sizePx: 58,
    params: {
      [PARAM.fontFamily]: "Inter", [PARAM.fontWeight]: "bold", [PARAM.color]: "#101322", [PARAM.lineHeight]: 1.15,
      [PARAM.bgEnabled]: true, [PARAM.bgColor]: "#ffd166", [PARAM.bgCornerRadius]: 18, [PARAM.bgPaddingX]: 130, [PARAM.bgPaddingY]: 62,
    },
  },
};

export const TEXT_STYLE_IDS = Object.keys(TEXT_STYLE_PRESETS);

/** How auto-captions look when a template carries them. Placement is a fraction of the canvas height from the center (+ is down). */
export interface CaptionStylePreset {
  text: string;
  positionYRatio: number;
}

export const CAPTION_STYLE_PRESETS: Readonly<Record<string, CaptionStylePreset>> = {
  "bold-lower": { text: "caption", positionYRatio: 0.26 },
  "bar-lower": { text: "title-bar", positionYRatio: 0.27 },
  "upper-third": { text: "caption", positionYRatio: -0.3 },
};
