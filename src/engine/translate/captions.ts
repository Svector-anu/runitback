import { PARAM, TEXT_SIZE_REFERENCE_HEIGHT, numberParam, stringParam, type CanvasSize, type TextElement, type TimelineElement } from "#/engine/model";

/** Average glyph advance as a fraction of the font size (the engine has no text measurer). */
const GLYPH_WIDTH_RATIO = 0.58;
const MAX_WIDTH_RATIO = 0.8;
const MIN_LINE_CHARS = 8;

/** Whether a clip is a caption created by import, transcript captions or an earlier translation. */
export function isCaptionClip(element: TimelineElement): element is TextElement {
  return element.type === "text" && /^Caption\b/.test(element.name ?? "");
}

export function captionText(element: TextElement): string {
  return stringParam(element.params, PARAM.content, "").replace(/\s*\n\s*/g, " ").trim();
}

function wrap(text: string, maxChars: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const candidate = line ? `${line} ${word}` : word;
    if (line && candidate.length > maxChars) {
      lines.push(line);
      line = word;
    } else line = candidate;
  }
  lines.push(line);
  return lines;
}

function metrics(element: TextElement, canvas: CanvasSize): { fontPx: number; lineHeight: number } {
  const fontPx = (numberParam(element.params, PARAM.fontSize, 5) * canvas.height) / TEXT_SIZE_REFERENCE_HEIGHT;
  return { fontPx, lineHeight: fontPx * numberParam(element.params, PARAM.lineHeight, 1.2) };
}

/**
 * A copy of caption `source` that says `translated`: same timing, style and animation, re-wrapped for the new length,
 * with the box grown away from the edge it hugs (bottom captions grow upward, top captions downward) so a longer line
 * never runs off the frame.
 */
export function translatedCaption(input: { source: TextElement; translated: string; id: string; name: string; canvas: CanvasSize }): TextElement {
  const { source, canvas } = input;
  const { fontPx, lineHeight } = metrics(source, canvas);
  const maxChars = Math.max(MIN_LINE_CHARS, Math.floor((canvas.width * MAX_WIDTH_RATIO) / (fontPx * GLYPH_WIDTH_RATIO)));
  const oldLines = stringParam(source.params, PARAM.content, "").split("\n").length;
  const lines = wrap(input.translated.replace(/\s+/g, " ").trim(), maxChars);
  const oldHeight = oldLines * lineHeight;
  const newHeight = lines.length * lineHeight;
  const y = numberParam(source.params, PARAM.positionY, 0);
  const shifted = y > 0 ? y + (oldHeight - newHeight) / 2 : y < 0 ? y - (oldHeight - newHeight) / 2 : y;
  return {
    ...source,
    id: input.id,
    name: input.name,
    params: { ...source.params, [PARAM.content]: lines.join("\n"), [PARAM.positionY]: Math.round(shifted) },
  };
}
