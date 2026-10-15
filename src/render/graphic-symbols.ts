import { numberParam, stringParam, type ParamValues } from "#/engine/model";
import type { AnyContext } from "./canvas";

/** Pointer outline in a 24-unit grid with the hotspot at (0, 0). */
const ARROW: ReadonlyArray<readonly [number, number]> = [[0, 0], [0, 17], [4.4, 13.2], [7.2, 19.6], [9.9, 18.4], [7.1, 12.2], [12.8, 12.2]];

/** One grid unit as a share of the shorter side of the box: a cursor in a 500 px box is about 55 px tall. */
const CURSOR_UNIT = 0.0055;
const RIPPLE_RADIUS = 0.16;

const easeOut = (t: number): number => 1 - (1 - t) ** 3;
const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));

function arrowPath(ctx: AnyContext): void {
  ctx.beginPath();
  ARROW.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
  ctx.closePath();
}

function handPath(ctx: AnyContext): void {
  ctx.beginPath();
  ctx.roundRect(-1.9, 0, 3.8, 12, 1.9);
  ctx.roundRect(-6.6, 9, 13.2, 10.5, 4);
}

function dotPath(ctx: AnyContext): void {
  ctx.beginPath();
  ctx.arc(0, 0, 2.6, 0, Math.PI * 2);
}

/** Expanding ring plus a soft disc at the hotspot; `click` runs 0..1, and 0 or 1 draw nothing. */
function drawRipple(ctx: AnyContext, params: ParamValues, unit: number): void {
  const click = numberParam(params, "click", 0);
  if (click <= 0 || click >= 1) return;
  const radius = unit * RIPPLE_RADIUS * easeOut(click);
  ctx.save();
  ctx.fillStyle = stringParam(params, "rippleColor", "#3b82f6");
  ctx.strokeStyle = ctx.fillStyle;
  ctx.globalAlpha = (1 - click) * 0.25;
  ctx.beginPath();
  ctx.arc(0, 0, radius, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalAlpha = (1 - click) * 0.9;
  ctx.lineWidth = Math.max(1.5, unit * 0.008 * (1 - click));
  ctx.stroke();
  ctx.restore();
}

/** A pointer with its hotspot at the centre of the box, plus the click ripple around it. */
export function drawCursor(ctx: AnyContext, params: ParamValues, width: number, height: number): void {
  const unit = Math.min(width, height);
  ctx.save();
  ctx.translate(width / 2, height / 2);
  drawRipple(ctx, params, unit);
  const click = numberParam(params, "click", 0);
  const press = click > 0 && click < 1 ? Math.sin(Math.PI * clamp01(click * 5)) : 0;
  const k = unit * CURSOR_UNIT * (1 - 0.12 * press);
  ctx.scale(k, k);
  ctx.lineJoin = "round";
  ctx.lineWidth = 2.4;
  ctx.strokeStyle = stringParam(params, "stroke", "#111111");
  ctx.fillStyle = stringParam(params, "fill", "#ffffff");
  const style = stringParam(params, "style", "arrow");
  const path = style === "hand" ? handPath : style === "dot" ? dotPath : arrowPath;
  path(ctx);
  ctx.stroke();
  path(ctx);
  ctx.fill();
  ctx.restore();
}

/** Title bar height and chrome sizes are authored at 1080 px canvas height. */
const BAR_PX = 46;
const TRAFFIC = ["#ff5f57", "#febc2e", "#28c840"] as const;

/** An app frame with an optional title bar (traffic lights, and an address pill for the browser style) filling the whole box. */
export function drawAppFrame(ctx: AnyContext, params: ParamValues, size: { width: number; height: number; canvasHeight: number }): void {
  const { width, height } = size;
  const sc = size.canvasHeight / 1080;
  const style = stringParam(params, "style", "mac");
  const radius = Math.min(numberParam(params, "cornerRadius", 12) * sc, Math.min(width, height) / 2);
  const bar = style === "plain" ? 0 : Math.min(BAR_PX * sc, height / 2);
  const outline = Math.max(1, 1.5 * sc);
  ctx.save();
  ctx.beginPath();
  ctx.roundRect(0, 0, width, height, radius);
  ctx.clip();
  ctx.fillStyle = stringParam(params, "fill", "#ffffff");
  ctx.fillRect(0, 0, width, height);
  if (bar > 0) {
    const edge = stringParam(params, "stroke", "#d4d4dc");
    ctx.fillStyle = stringParam(params, "barColor", "#ececf1");
    ctx.fillRect(0, 0, width, bar);
    ctx.fillStyle = edge;
    ctx.fillRect(0, bar - outline, width, outline);
    TRAFFIC.forEach((color, i) => {
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc((22 + i * 22) * sc, bar / 2, 6.5 * sc, 0, Math.PI * 2);
      ctx.fill();
    });
    if (style === "browser") {
      const pillWidth = Math.min(width * 0.5, 620 * sc);
      ctx.fillStyle = stringParam(params, "fill", "#ffffff");
      ctx.strokeStyle = edge;
      ctx.lineWidth = outline;
      ctx.beginPath();
      ctx.roundRect((width - pillWidth) / 2, bar * 0.2, pillWidth, bar * 0.6, bar * 0.3);
      ctx.fill();
      ctx.stroke();
    }
  }
  ctx.restore();
  ctx.strokeStyle = stringParam(params, "stroke", "#d4d4dc");
  ctx.lineWidth = outline;
  ctx.beginPath();
  ctx.roundRect(outline / 2, outline / 2, width - outline, height - outline, Math.max(0, radius - outline / 2));
  ctx.stroke();
}
