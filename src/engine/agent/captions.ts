import type { CaptionCue } from "#/engine/captions";
import {
  DEFAULT_ELEMENT_DURATION, PARAM, TEXT_DEFAULTS, TEXT_SIZE_REFERENCE_HEIGHT, type CanvasSize, type ElementAnimations, type IdGenerator, type ParamValues, type TextElement,
} from "#/engine/model";
import { mediaTime, type MediaTime } from "#/engine/time";
import { upsertKeyframe } from "#/engine/animation";

const MAX_WIDTH_RATIO = 0.8;
const DEFAULT_FONT_SIZE = 5;
const DEFAULT_MARGIN_RATIO = 0.05;
/** Average glyph advance as a fraction of the font size; there is no text measurer in the pure engine. */
const GLYPH_WIDTH_RATIO = 0.58;

function wrap(text: string, maxChars: number): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split("\n")) {
    let line = "";
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      const candidate = line ? `${line} ${word}` : word;
      if (line && candidate.length > maxChars) {
        lines.push(line);
        line = word;
      } else {
        line = candidate;
      }
    }
    lines.push(line);
  }
  return lines;
}

/** Word-by-word highlight of a caption: the colour, and when each word starts being spoken (ticks from the caption's start). */
export interface CaptionHighlight {
  color: string;
  /** Keep words lit after they are spoken (karaoke sweep) instead of lighting only the current one. */
  sweep: boolean;
  wordStarts: ReadonlyArray<number>;
  newId: IdGenerator;
}

/** Stepped `highlightWord` keyframes: -1 before the first word, then the index of the word being spoken. */
export function highlightAnimations(input: { highlight: CaptionHighlight; duration: number }): ElementAnimations {
  const { highlight } = input;
  let animations: ElementAnimations = {};
  const key = (time: number, value: number): void => {
    animations = upsertKeyframe({ animations, path: PARAM.highlightWord, time: mediaTime(Math.max(0, Math.min(Math.round(time), input.duration - 1))), value, interpolation: "hold", newId: highlight.newId });
  };
  key(0, -1);
  highlight.wordStarts.forEach((start, index) => key(start, index));
  return animations;
}

/**
 * A caption cue as a bottom-anchored (or ASS-positioned) text element. Mirrors render/caption-elements.ts but
 * estimates text size instead of measuring it, because the engine has no canvas.
 */
export function captionElement(input: {
  cue: CaptionCue; index: number; id: string; canvas: CanvasSize; startTime: MediaTime; duration: MediaTime; highlight?: CaptionHighlight;
}): TextElement {
  const { cue, canvas } = input;
  const style = cue.style;
  const fontSize = style?.fontSizeRatio ? style.fontSizeRatio * TEXT_SIZE_REFERENCE_HEIGHT : DEFAULT_FONT_SIZE;
  const marginLeft = style?.marginLeftRatio ?? 0;
  const marginRight = style?.marginRightRatio ?? 0;
  const maxWidth = style?.marginLeftRatio !== undefined ? canvas.width * (1 - marginLeft - marginRight) : canvas.width * MAX_WIDTH_RATIO;
  const fontPx = (fontSize * canvas.height) / TEXT_SIZE_REFERENCE_HEIGHT;

  const params: ParamValues = {
    ...TEXT_DEFAULTS,
    [PARAM.fontFamily]: style?.fontFamily ?? "Arial",
    [PARAM.fontSize]: Math.round(fontSize * 1000) / 1000,
    [PARAM.color]: style?.color ?? "#ffffff",
    [PARAM.fontWeight]: style?.bold === false ? "normal" : "bold",
    [PARAM.fontStyle]: style?.italic ? "italic" : "normal",
    [PARAM.textDecoration]: style?.underline ? "underline" : style?.strikeOut ? "line-through" : "none",
    [PARAM.letterSpacing]: style?.letterSpacing ?? 0,
    [PARAM.textAlign]: style?.align ?? "center",
  };
  if (style?.backgroundColor) {
    params[PARAM.bgEnabled] = true;
    params[PARAM.bgColor] = style.backgroundColor;
  }
  const lines = wrap(cue.text, Math.max(8, Math.floor(maxWidth / (fontPx * GLYPH_WIDTH_RATIO))));
  params[PARAM.content] = lines.join("\n");

  const textHeight = lines.length * fontPx * (typeof params[PARAM.lineHeight] === "number" ? (params[PARAM.lineHeight] as number) : 1.2);
  const margin = canvas.height * (style?.marginVerticalRatio ?? DEFAULT_MARGIN_RATIO);
  const vertical = style?.vertical ?? "bottom";
  let positionY = canvas.height / 2 - margin - textHeight / 2;
  if (vertical === "top") positionY = -canvas.height / 2 + margin + textHeight / 2;
  else if (vertical === "middle") positionY = 0;
  let positionX = 0;
  if (style?.align === "left") positionX = -canvas.width / 2 + canvas.width * marginLeft;
  else if (style?.align === "right") positionX = canvas.width / 2 - canvas.width * marginRight;
  params[PARAM.positionX] = Math.round(positionX);
  params[PARAM.positionY] = Math.round(positionY);

  const duration = input.duration > 0 ? input.duration : DEFAULT_ELEMENT_DURATION;
  const highlight = input.highlight;
  if (highlight) {
    params[PARAM.highlightColor] = highlight.color;
    params[PARAM.highlightSweep] = highlight.sweep;
  }
  return {
    id: input.id, type: "text", name: `Caption ${input.index + 1}`, startTime: input.startTime, duration,
    trimStart: mediaTime(0), trimEnd: mediaTime(0), params, hidden: false,
    ...(highlight && highlight.wordStarts.length > 0 ? { animations: highlightAnimations({ highlight, duration }) } : {}),
  };
}
