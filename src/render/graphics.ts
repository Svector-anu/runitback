import { DEFAULT_GRAPHIC_SOURCE_SIZE, numberParam, stringParam, type ParamValues } from "#/engine/model";
import { context2d, createCanvas, type AnyCanvas, type AnyContext } from "./canvas";

export interface Point { x: number; y: number }

/** Regular polygon vertices; the first vertex points up. */
export function polygonVertices(input: { sides: number; cx: number; cy: number; radius: number }): Point[] {
  return Array.from({ length: input.sides }, (_, i) => {
    const a = -Math.PI / 2 + (i * 2 * Math.PI) / input.sides;
    return { x: input.cx + input.radius * Math.cos(a), y: input.cy + input.radius * Math.sin(a) };
  });
}

/** Star vertices alternating outer and inner radius; inner = outer * depth/100. */
export function starVertices(input: { points: number; cx: number; cy: number; radius: number; depth: number }): Point[] {
  const inner = input.radius * (input.depth / 100);
  return Array.from({ length: input.points * 2 }, (_, i) => {
    const a = -Math.PI / 2 + (i * Math.PI) / input.points;
    const r = i % 2 === 0 ? input.radius : inner;
    return { x: input.cx + r * Math.cos(a), y: input.cy + r * Math.sin(a) };
  });
}

function roundedPolygonPath(path: Path2D, vertices: Point[], radius: number): void {
  const n = vertices.length;
  if (radius <= 0) {
    vertices.forEach((v, i) => (i === 0 ? path.moveTo(v.x, v.y) : path.lineTo(v.x, v.y)));
    path.closePath();
    return;
  }
  for (let i = 0; i < n; i++) {
    const prev = vertices[(i + n - 1) % n] as Point;
    const cur = vertices[i] as Point;
    const next = vertices[(i + 1) % n] as Point;
    const toPrev = { x: prev.x - cur.x, y: prev.y - cur.y };
    const toNext = { x: next.x - cur.x, y: next.y - cur.y };
    const limit = Math.min(Math.hypot(toPrev.x, toPrev.y), Math.hypot(toNext.x, toNext.y)) / 2;
    const r = Math.min(radius, limit);
    const start = { x: cur.x + (toPrev.x / Math.hypot(toPrev.x, toPrev.y)) * r, y: cur.y + (toPrev.y / Math.hypot(toPrev.x, toPrev.y)) * r };
    const end = { x: cur.x + (toNext.x / Math.hypot(toNext.x, toNext.y)) * r, y: cur.y + (toNext.y / Math.hypot(toNext.x, toNext.y)) * r };
    if (i === 0) path.moveTo(start.x, start.y);
    else path.lineTo(start.x, start.y);
    path.quadraticCurveTo(cur.x, cur.y, end.x, end.y);
  }
  path.closePath();
}

export function graphicPath(definitionId: string, params: ParamValues, size: number, inset: number): Path2D {
  const path = new Path2D();
  const c = size / 2;
  const r = size / 2 - inset;
  switch (definitionId) {
    case "rectangle": {
      const pct = numberParam(params, "cornerRadius", 0);
      const radius = (r * pct) / 50;
      path.roundRect(inset, inset, size - inset * 2, size - inset * 2, radius);
      break;
    }
    case "ellipse":
      path.ellipse(c, c, r, r, 0, 0, Math.PI * 2);
      break;
    case "polygon": {
      const sides = Math.round(numberParam(params, "sides", 5));
      const maxCorner = r * Math.sin(Math.PI / sides);
      roundedPolygonPath(path, polygonVertices({ sides, cx: c, cy: c, radius: r }), (maxCorner * numberParam(params, "cornerRadius", 0)) / 50);
      break;
    }
    case "star": {
      const points = Math.round(numberParam(params, "points", 5));
      roundedPolygonPath(path, starVertices({ points, cx: c, cy: c, radius: r, depth: numberParam(params, "depth", 45) }), 0);
      break;
    }
    default:
      throw new Error(`Unknown graphic "${definitionId}"`);
  }
  return path;
}

/** Fill plus aligned stroke, drawn into a square canvas that is then treated as an image. */
export function drawGraphic(ctx: AnyContext, definitionId: string, params: ParamValues, size = DEFAULT_GRAPHIC_SOURCE_SIZE): void {
  const strokeWidth = numberParam(params, "strokeWidth", 0);
  const align = stringParam(params, "strokeAlign", "center");
  const fill = stringParam(params, "fill", "#ffffff");
  const stroke = stringParam(params, "stroke", "#000000");
  ctx.clearRect(0, 0, size, size);

  const inset = strokeWidth > 0 && align === "center" ? strokeWidth / 2 : 0;
  const path = graphicPath(definitionId, params, size, inset);
  ctx.fillStyle = fill;
  ctx.fill(path);
  if (strokeWidth <= 0) return;

  ctx.strokeStyle = stroke;
  if (align === "center") {
    ctx.lineWidth = strokeWidth;
    ctx.stroke(path);
  } else if (align === "inside") {
    ctx.save();
    ctx.clip(path);
    ctx.lineWidth = strokeWidth * 2;
    ctx.stroke(path);
    ctx.restore();
  } else {
    const scratch = createCanvas(size, size);
    const sctx = context2d(scratch);
    sctx.strokeStyle = stroke;
    sctx.lineWidth = strokeWidth * 2;
    sctx.stroke(path);
    sctx.globalCompositeOperation = "destination-out";
    sctx.fill(path);
    ctx.drawImage(scratch as CanvasImageSource, 0, 0);
  }
}

export class GraphicCache {
  private readonly cache = new Map<string, AnyCanvas>();

  get(definitionId: string, params: ParamValues): AnyCanvas {
    const key = `${definitionId}:${JSON.stringify(params)}`;
    let canvas = this.cache.get(key);
    if (!canvas) {
      canvas = createCanvas(DEFAULT_GRAPHIC_SOURCE_SIZE, DEFAULT_GRAPHIC_SOURCE_SIZE);
      drawGraphic(context2d(canvas), definitionId, params);
      if (this.cache.size > 64) this.cache.delete(this.cache.keys().next().value as string);
      this.cache.set(key, canvas);
    }
    return canvas;
  }

  clear(): void {
    this.cache.clear();
  }
}
