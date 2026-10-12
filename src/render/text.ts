import { TEXT_SIZE_REFERENCE_HEIGHT, boolParam, numberParam, stringParam, PARAM, type ParamValues } from "#/engine/model";
import type { AnyContext } from "./canvas";

export interface Rect { left: number; top: number; width: number; height: number }

export interface TextLayout {
  lines: string[];
  /** Measured width of every full line (before any typewriter reveal). */
  lineWidths: number[];
  /** Fraction of characters shown (1 = all). */
  reveal: number;
  /** Stroke and shadow sizes are authored at font size 15 and scale with the font. */
  styleScale: number;
  font: string;
  scaledFontSize: number;
  lineHeightPx: number;
  letterSpacing: number;
  align: "left" | "center" | "right";
  /** Y of each line's middle baseline relative to the block anchor. */
  lineYs: number[];
  textRect: Rect;
  backgroundRect: Rect | null;
  backgroundRadius: number;
  /** Union of text and background; used for selection bounds. */
  visualRect: Rect;
  decoration: "none" | "underline" | "line-through";
  decorationThickness: number;
}

/** Measures one line at the font already described by `font`/`letterSpacing`. */
export type LineMeasurer = (line: string, font: string, letterSpacing: number) => number;

const union = (a: Rect, b: Rect): Rect => {
  const left = Math.min(a.left, b.left);
  const top = Math.min(a.top, b.top);
  return { left, top, width: Math.max(a.left + a.width, b.left + b.width) - left, height: Math.max(a.top + a.height, b.top + b.height) - top };
};

/** Font size is expressed against a 90-unit canvas height, so size 15 on 1080p is 180px. */
export function scaledFontSize(fontSize: number, canvasHeight: number): number {
  return fontSize * (canvasHeight / TEXT_SIZE_REFERENCE_HEIGHT);
}

export function layoutText(input: { params: ParamValues; canvasHeight: number; measure: LineMeasurer }): TextLayout {
  const { params } = input;
  const fontSize = numberParam(params, PARAM.fontSize, 15);
  const px = scaledFontSize(fontSize, input.canvasHeight);
  const family = stringParam(params, PARAM.fontFamily, "Arial");
  const weight = stringParam(params, PARAM.fontWeight, "normal");
  const style = stringParam(params, PARAM.fontStyle, "normal");
  const font = `${style} ${weight} ${px}px "${family}", sans-serif`;
  const letterSpacing = numberParam(params, PARAM.letterSpacing, 0);
  const lineHeightPx = px * numberParam(params, PARAM.lineHeight, 1.2);
  const align = stringParam(params, PARAM.textAlign, "center") as TextLayout["align"];
  const lines = stringParam(params, PARAM.content, "").split("\n");

  const lineWidths = lines.map((l) => input.measure(l, font, letterSpacing));
  const maxWidth = Math.max(0, ...lineWidths);
  const height = lines.length * lineHeightPx;
  const centerOffset = ((lines.length - 1) * lineHeightPx) / 2;
  const left = align === "left" ? 0 : align === "right" ? -maxWidth : -maxWidth / 2;
  const textRect: Rect = { left, top: -height / 2, width: maxWidth, height };

  let backgroundRect: Rect | null = null;
  let backgroundRadius = 0;
  if (boolParam(params, PARAM.bgEnabled, false) && stringParam(params, PARAM.bgColor, "#000000") !== "transparent") {
    const ratio = fontSize / 15;
    const padX = numberParam(params, PARAM.bgPaddingX, 30) * ratio;
    const padY = numberParam(params, PARAM.bgPaddingY, 42) * ratio;
    backgroundRect = {
      left: textRect.left - padX + numberParam(params, PARAM.bgOffsetX, 0),
      top: textRect.top - padY + numberParam(params, PARAM.bgOffsetY, 0),
      width: textRect.width + padX * 2,
      height: textRect.height + padY * 2,
    };
    const pct = Math.min(100, Math.max(0, numberParam(params, PARAM.bgCornerRadius, 0)));
    backgroundRadius = (Math.min(backgroundRect.width, backgroundRect.height) / 2) * (pct / 100);
  }

  const decoration = stringParam(params, PARAM.textDecoration, "none") as TextLayout["decoration"];
  return {
    lines, lineWidths, reveal: Math.min(1, Math.max(0, numberParam(params, PARAM.reveal, 1))), styleScale: fontSize / 15,
    font, scaledFontSize: px, lineHeightPx, letterSpacing, align,
    lineYs: lines.map((_, i) => i * lineHeightPx - centerOffset),
    textRect, backgroundRect, backgroundRadius,
    visualRect: backgroundRect ? union(textRect, backgroundRect) : textRect,
    decoration, decorationThickness: Math.max(1, px * 0.07),
  };
}

export function canvasLineMeasurer(ctx: AnyContext): LineMeasurer {
  return (line, font, letterSpacing) => {
    ctx.font = font;
    (ctx as unknown as { letterSpacing: string }).letterSpacing = `${letterSpacing}px`;
    return ctx.measureText(line).width;
  };
}

function roundedRectPath(ctx: AnyContext, r: Rect, radius: number): void {
  ctx.beginPath();
  if (radius > 0 && "roundRect" in ctx) (ctx as CanvasRenderingContext2D).roundRect(r.left, r.top, r.width, r.height, radius);
  else ctx.rect(r.left, r.top, r.width, r.height);
}

/** Draws at the current origin, which the caller has translated/scaled/rotated to the element transform. */
export function drawTextLayout(ctx: AnyContext, layout: TextLayout, params: ParamValues): void {
  if (layout.backgroundRect) {
    ctx.fillStyle = stringParam(params, PARAM.bgColor, "#000000");
    roundedRectPath(ctx, layout.backgroundRect, layout.backgroundRadius);
    ctx.fill();
  }
  ctx.font = layout.font;
  (ctx as unknown as { letterSpacing: string }).letterSpacing = `${layout.letterSpacing}px`;
  ctx.textBaseline = "middle";
  ctx.lineJoin = "round";
  const fill = stringParam(params, PARAM.color, "#ffffff");
  const strokeWidth = numberParam(params, PARAM.strokeWidth, 0) * layout.styleScale;
  const strokeColor = stringParam(params, PARAM.strokeColor, "#000000");
  const shadow = boolParam(params, PARAM.shadowEnabled, false) ? shadowOf(ctx, params, layout.styleScale) : null;
  const shown = visibleCounts(layout.lines, layout.reveal);

  layout.lines.forEach((full, i) => {
    const chars = shown[i] as number;
    if (chars === 0) return;
    const line = chars >= [...full].length ? full : [...full].slice(0, chars).join("");
    const y = layout.lineYs[i] as number;
    const width = layout.lineWidths[i] as number;
    const revealing = layout.reveal < 1;
    // While revealing, text is anchored where the finished line will sit so it grows in place instead of re-centring.
    ctx.textAlign = revealing ? "left" : layout.align;
    const x = revealing ? (layout.align === "left" ? 0 : layout.align === "right" ? -width : -width / 2) : 0;
    if (strokeWidth > 0) {
      applyShadow(ctx, shadow);
      ctx.strokeStyle = strokeColor;
      ctx.lineWidth = strokeWidth * 2;
      ctx.strokeText(line, x, y);
      clearShadow(ctx);
      ctx.fillStyle = fill;
      ctx.fillText(line, x, y);
    } else {
      applyShadow(ctx, shadow);
      ctx.fillStyle = fill;
      ctx.fillText(line, x, y);
      clearShadow(ctx);
    }
    if (layout.decoration === "none" || line.length === 0) return;
    const measured = ctx.measureText(line).width;
    const left = revealing ? x : layout.align === "left" ? 0 : layout.align === "right" ? -measured : -measured / 2;
    const offset = layout.decoration === "underline" ? layout.scaledFontSize * 0.4 : -layout.scaledFontSize * 0.08;
    ctx.fillStyle = fill;
    ctx.fillRect(left, y + offset, measured, layout.decorationThickness);
  });
}

/** How many characters of each line are visible when `reveal` of the whole text is shown (characters counted across lines). */
export function visibleCounts(lines: ReadonlyArray<string>, reveal: number): number[] {
  const lengths = lines.map((l) => [...l].length);
  if (reveal >= 1) return lengths;
  let remaining = Math.floor(lengths.reduce((a, b) => a + b, 0) * Math.max(0, reveal));
  return lengths.map((length) => {
    const take = Math.min(length, remaining);
    remaining -= take;
    return take;
  });
}

interface ShadowSpec { color: string; blur: number; offsetX: number; offsetY: number }

/** Canvas shadow offsets ignore the current transform; rotate/scale them by it so the shadow follows the text. */
function shadowOf(ctx: AnyContext, params: ParamValues, scale: number): ShadowSpec {
  const m = ctx.getTransform();
  const dx = numberParam(params, PARAM.shadowOffsetX, 4) * scale;
  const dy = numberParam(params, PARAM.shadowOffsetY, 4) * scale;
  return {
    color: stringParam(params, PARAM.shadowColor, "#000000b3"),
    blur: numberParam(params, PARAM.shadowBlur, 8) * scale * Math.sqrt(Math.abs(m.a * m.d - m.b * m.c)),
    offsetX: m.a * dx + m.c * dy,
    offsetY: m.b * dx + m.d * dy,
  };
}

function applyShadow(ctx: AnyContext, shadow: ShadowSpec | null): void {
  if (!shadow) return;
  ctx.shadowColor = shadow.color;
  ctx.shadowBlur = shadow.blur;
  ctx.shadowOffsetX = shadow.offsetX;
  ctx.shadowOffsetY = shadow.offsetY;
}

function clearShadow(ctx: AnyContext): void {
  ctx.shadowColor = "rgba(0,0,0,0)";
  ctx.shadowBlur = 0;
  ctx.shadowOffsetX = 0;
  ctx.shadowOffsetY = 0;
}

export function drawText(input: {
  ctx: AnyContext; params: ParamValues; canvasWidth: number; canvasHeight: number;
}): TextLayout {
  const { ctx, params } = input;
  const layout = layoutText({ params, canvasHeight: input.canvasHeight, measure: canvasLineMeasurer(ctx) });
  ctx.save();
  ctx.translate(input.canvasWidth / 2 + numberParam(params, PARAM.positionX, 0), input.canvasHeight / 2 + numberParam(params, PARAM.positionY, 0));
  ctx.scale(numberParam(params, PARAM.scaleX, 1), numberParam(params, PARAM.scaleY, 1));
  ctx.rotate((numberParam(params, PARAM.rotate, 0) * Math.PI) / 180);
  drawTextLayout(ctx, layout, params);
  ctx.restore();
  return layout;
}
