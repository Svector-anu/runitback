import { TEXT_SIZE_REFERENCE_HEIGHT, boolParam, numberParam, stringParam, PARAM, type ParamValues } from "#/engine/model";
import type { AnyContext } from "./canvas";

export interface Rect { left: number; top: number; width: number; height: number }

export interface TextLayout {
  lines: string[];
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

  const maxWidth = Math.max(0, ...lines.map((l) => input.measure(l, font, letterSpacing)));
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
    lines, font, scaledFontSize: px, lineHeightPx, letterSpacing, align,
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
  ctx.textAlign = layout.align;
  ctx.textBaseline = "middle";
  ctx.fillStyle = stringParam(params, PARAM.color, "#ffffff");
  layout.lines.forEach((line, i) => {
    const y = layout.lineYs[i] as number;
    ctx.fillText(line, 0, y);
    if (layout.decoration === "none" || line.length === 0) return;
    const width = ctx.measureText(line).width;
    const x = layout.align === "left" ? 0 : layout.align === "right" ? -width : -width / 2;
    const offset = layout.decoration === "underline" ? layout.scaledFontSize * 0.4 : -layout.scaledFontSize * 0.08;
    ctx.fillRect(x, y + offset, width, layout.decorationThickness);
  });
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
