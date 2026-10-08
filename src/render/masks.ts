import { numberParam, stringParam, boolParam, type MaskType, type ParamValues } from "#/engine/model";
import { context2d, createCanvas, type AnyCanvas, type AnyContext } from "./canvas";
import type { Point } from "./graphics";

export type MaskShape =
  | { kind: "polygon"; points: Point[] }
  | { kind: "ellipse"; cx: number; cy: number; rx: number; ry: number; rotation: number }
  | { kind: "heart"; cx: number; cy: number; halfW: number; halfH: number; rotation: number };

export const MIN_MASK_DIMENSION = 0.01;
export const STAR_INNER_RATIO = 0.45;

function rotatePoint(p: Point, center: Point, radians: number): Point {
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const dx = p.x - center.x;
  const dy = p.y - center.y;
  return { x: center.x + dx * cos - dy * sin, y: center.y + dx * sin + dy * cos };
}

/**
 * Mask geometry in element-local pixels, origin at the element's centre and `w` x `h` its drawn size.
 * Centres and sizes in params are fractions of that size.
 */
export function maskShape(type: MaskType, params: ParamValues, w: number, h: number): MaskShape {
  const cx = numberParam(params, "centerX", 0) * w;
  const cy = numberParam(params, "centerY", 0) * h;
  const rotation = (numberParam(params, "rotation", 0) * Math.PI) / 180;
  const bw = Math.max(MIN_MASK_DIMENSION, numberParam(params, "width", 0.6)) * w;
  const bh = Math.max(MIN_MASK_DIMENSION, numberParam(params, "height", 0.6)) * h;
  const center = { x: cx, y: cy };
  const rot = (points: Point[]): Point[] => points.map((p) => rotatePoint(p, center, rotation));

  switch (type) {
    case "rectangle":
      return { kind: "polygon", points: rot([
        { x: cx - bw / 2, y: cy - bh / 2 }, { x: cx + bw / 2, y: cy - bh / 2 },
        { x: cx + bw / 2, y: cy + bh / 2 }, { x: cx - bw / 2, y: cy + bh / 2 },
      ]) };
    case "cinematic-bars": {
      const length = Math.max(bw, w, Math.hypot(w, h));
      return { kind: "polygon", points: rot([
        { x: cx - length / 2, y: cy - bh / 2 }, { x: cx + length / 2, y: cy - bh / 2 },
        { x: cx + length / 2, y: cy + bh / 2 }, { x: cx - length / 2, y: cy + bh / 2 },
      ]) };
    }
    case "ellipse":
      return { kind: "ellipse", cx, cy, rx: bw / 2, ry: bh / 2, rotation };
    case "diamond":
      return { kind: "polygon", points: rot([
        { x: cx, y: cy - bh / 2 }, { x: cx + bw / 2, y: cy }, { x: cx, y: cy + bh / 2 }, { x: cx - bw / 2, y: cy },
      ]) };
    case "star": {
      const points: Point[] = [];
      for (let i = 0; i < 10; i++) {
        const a = -Math.PI / 2 + (i * Math.PI) / 5;
        const k = i % 2 === 0 ? 1 : STAR_INNER_RATIO;
        points.push({ x: cx + Math.cos(a) * (bw / 2) * k, y: cy + Math.sin(a) * (bh / 2) * k });
      }
      return { kind: "polygon", points: rot(points) };
    }
    case "heart":
      return { kind: "heart", cx, cy, halfW: bw / 2, halfH: bh / 2, rotation };
    case "split": {
      const reach = Math.hypot(w, h) * 2;
      const nx = Math.cos(rotation);
      const ny = Math.sin(rotation);
      const tx = -ny;
      const ty = nx;
      return { kind: "polygon", points: [
        { x: cx + tx * reach, y: cy + ty * reach }, { x: cx - tx * reach, y: cy - ty * reach },
        { x: cx - tx * reach + nx * reach, y: cy - ty * reach + ny * reach },
        { x: cx + tx * reach + nx * reach, y: cy + ty * reach + ny * reach },
      ] };
    }
  }
}

export function shapePath(shape: MaskShape): Path2D {
  const path = new Path2D();
  if (shape.kind === "polygon") {
    shape.points.forEach((p, i) => (i === 0 ? path.moveTo(p.x, p.y) : path.lineTo(p.x, p.y)));
    path.closePath();
  } else if (shape.kind === "ellipse") {
    path.ellipse(shape.cx, shape.cy, Math.max(0.5, shape.rx), Math.max(0.5, shape.ry), shape.rotation, 0, Math.PI * 2);
  } else {
    const { cx, cy, halfW, halfH } = shape;
    const m = new DOMMatrix().translate(cx, cy).rotate((shape.rotation * 180) / Math.PI);
    const heart = new Path2D();
    heart.moveTo(0, halfH * 0.725);
    heart.bezierCurveTo(-halfW * 1.15, halfH * -0.125, -halfW, halfH * -0.475, 0, halfH * -0.6);
    heart.bezierCurveTo(halfW, halfH * -0.475, halfW * 1.15, halfH * -0.125, 0, halfH * 0.725);
    heart.closePath();
    path.addPath(heart, m);
  }
  return path;
}

export interface MaskRenderInput {
  type: MaskType;
  params: ParamValues;
  /** Element transform on the canvas. */
  center: Point;
  width: number;
  height: number;
  rotationDegrees: number;
  flipX: boolean;
  flipY: boolean;
  canvasWidth: number;
  canvasHeight: number;
}

function applyElementTransform(ctx: AnyContext, i: MaskRenderInput): void {
  ctx.translate(i.center.x, i.center.y);
  ctx.rotate((i.rotationDegrees * Math.PI) / 180);
  ctx.scale(i.flipX ? -1 : 1, i.flipY ? -1 : 1);
}

/** Opaque where the layer is kept; feather softens the edge (gaussian approximation of classic's SDF smoothstep). */
export function renderMask(input: MaskRenderInput): AnyCanvas {
  const canvas = createCanvas(input.canvasWidth, input.canvasHeight);
  const ctx = context2d(canvas);
  const feather = numberParam(input.params, "feather", 0);
  if (feather > 0) ctx.filter = `blur(${feather / 4}px)`;
  ctx.save();
  applyElementTransform(ctx, input);
  ctx.fillStyle = "#fff";
  ctx.fill(shapePath(maskShape(input.type, input.params, input.width, input.height)));
  ctx.restore();
  ctx.filter = "none";
  return canvas;
}

/** Stroke drawn as its own layer after the element, unmasked. Returns null when no stroke is configured. */
export function renderMaskStroke(input: MaskRenderInput): AnyCanvas | null {
  const width = numberParam(input.params, "strokeWidth", 0);
  if (width <= 0) return null;
  const align = stringParam(input.params, "strokeAlign", "center");
  const canvas = createCanvas(input.canvasWidth, input.canvasHeight);
  const ctx = context2d(canvas);
  const path = shapePath(maskShape(input.type, input.params, input.width, input.height));
  ctx.save();
  applyElementTransform(ctx, input);
  ctx.strokeStyle = stringParam(input.params, "strokeColor", "#ffffff");
  if (align === "inside") {
    ctx.clip(path);
    ctx.lineWidth = width * 2;
    ctx.stroke(path);
  } else if (align === "outside") {
    ctx.lineWidth = width * 2;
    ctx.stroke(path);
    ctx.globalCompositeOperation = "destination-out";
    ctx.fill(path);
  } else {
    ctx.lineWidth = width;
    ctx.stroke(path);
  }
  ctx.restore();
  return canvas;
}

export const isInverted = (params: ParamValues): boolean => boolParam(params, "inverted", false);
