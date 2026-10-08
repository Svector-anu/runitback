import type { CaptionCue } from "#/engine/captions";
import {
  DEFAULT_ELEMENT_DURATION, PARAM, TEXT_DEFAULTS, TEXT_SIZE_REFERENCE_HEIGHT, type CanvasSize, type ParamValues, type TextElement,
} from "#/engine/model";
import { mediaTime } from "#/engine/time";
import { layoutText, type LineMeasurer } from "./text";

export const SUBTITLE_MAX_WIDTH_RATIO = 0.8;
export const SUBTITLE_DEFAULT_FONT_SIZE = 5;
export const SUBTITLE_DEFAULT_MARGIN_RATIO = 0.05;

/** Greedy word wrap; existing newlines are kept. */
export function wrapText(input: { text: string; maxWidth: number; measure: (line: string) => number }): string {
  const out: string[] = [];
  for (const paragraph of input.text.split("\n")) {
    const words = paragraph.split(/\s+/).filter(Boolean);
    let line = "";
    for (const word of words) {
      const candidate = line ? `${line} ${word}` : word;
      if (line && input.measure(candidate) > input.maxWidth) {
        out.push(line);
        line = word;
      } else {
        line = candidate;
      }
    }
    out.push(line);
  }
  return out.join("\n");
}

/** A caption cue becomes a bottom-anchored (or ASS-positioned) white bold text element. */
export function buildCaptionElement(input: {
  cue: CaptionCue; index: number; id: string; canvas: CanvasSize; measure: LineMeasurer;
}): TextElement {
  const { cue, canvas } = input;
  const style = cue.style;
  const fontSize = style?.fontSizeRatio ? style.fontSizeRatio * TEXT_SIZE_REFERENCE_HEIGHT : SUBTITLE_DEFAULT_FONT_SIZE;
  const marginLeft = style?.marginLeftRatio ?? 0;
  const marginRight = style?.marginRightRatio ?? 0;
  const maxWidth = style?.marginLeftRatio !== undefined ? canvas.width * (1 - marginLeft - marginRight) : canvas.width * SUBTITLE_MAX_WIDTH_RATIO;

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

  const wrapMeasure = layoutText({ params, canvasHeight: canvas.height, measure: input.measure });
  const content = wrapText({ text: cue.text, maxWidth, measure: (line) => input.measure(line, wrapMeasure.font, wrapMeasure.letterSpacing) });
  params[PARAM.content] = content;

  const layout = layoutText({ params, canvasHeight: canvas.height, measure: input.measure });
  const margin = canvas.height * (style?.marginVerticalRatio ?? SUBTITLE_DEFAULT_MARGIN_RATIO);
  const vertical = style?.vertical ?? "bottom";
  const rect = layout.visualRect;
  let positionY: number;
  if (vertical === "top") positionY = -canvas.height / 2 + margin - rect.top;
  else if (vertical === "middle") positionY = 0;
  else positionY = canvas.height / 2 - margin - (rect.top + rect.height);
  let positionX = 0;
  if (style?.align === "left") positionX = -canvas.width / 2 + canvas.width * marginLeft;
  else if (style?.align === "right") positionX = canvas.width / 2 - canvas.width * marginRight;
  params[PARAM.positionX] = Math.round(positionX);
  params[PARAM.positionY] = Math.round(positionY);

  return {
    id: input.id, type: "text", name: `Caption ${input.index + 1}`, startTime: cue.startTime, duration: cue.duration > 0 ? cue.duration : DEFAULT_ELEMENT_DURATION,
    trimStart: mediaTime(0), trimEnd: mediaTime(0), params, hidden: false,
  };
}
