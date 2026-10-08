import { numberParam, PARAM, type CanvasSize } from "#/engine/model";
import type { DrawItem, FramePlan } from "#/engine/render";
import { context2d, createCanvas } from "./canvas";
import { canvasLineMeasurer, layoutText, type LineMeasurer } from "./text";

export interface ElementBounds {
  elementId: string;
  /** Centre in canvas pixels. */
  cx: number;
  cy: number;
  width: number;
  height: number;
  rotationDegrees: number;
  kind: "media" | "text";
}

let measurer: LineMeasurer | null = null;
function defaultMeasurer(): LineMeasurer {
  measurer ??= canvasLineMeasurer(context2d(createCanvas(8, 8)));
  return measurer;
}

/** Rotated-rectangle bounds of a drawn item, ignoring effects and masks. Audio and scene effects have none. */
export function itemBounds(item: DrawItem, canvas: CanvasSize, measure: LineMeasurer = defaultMeasurer()): ElementBounds | null {
  if (item.kind === "layer") {
    const t = item.transform;
    return { elementId: item.elementId, cx: t.centerX, cy: t.centerY, width: t.width, height: t.height, rotationDegrees: t.rotationDegrees, kind: "media" };
  }
  if (item.kind !== "text") return null;
  const params = item.params;
  const layout = layoutText({ params, canvasHeight: canvas.height, measure });
  const sx = numberParam(params, PARAM.scaleX, 1);
  const sy = numberParam(params, PARAM.scaleY, 1);
  const rotation = numberParam(params, PARAM.rotate, 0);
  const rad = (rotation * Math.PI) / 180;
  const rect = layout.visualRect;
  const localX = (rect.left + rect.width / 2) * sx;
  const localY = (rect.top + rect.height / 2) * sy;
  const ax = canvas.width / 2 + numberParam(params, PARAM.positionX, 0);
  const ay = canvas.height / 2 + numberParam(params, PARAM.positionY, 0);
  return {
    elementId: item.elementId,
    cx: ax + localX * Math.cos(rad) - localY * Math.sin(rad),
    cy: ay + localX * Math.sin(rad) + localY * Math.cos(rad),
    width: Math.abs(rect.width * sx), height: Math.abs(rect.height * sy), rotationDegrees: rotation, kind: "text",
  };
}

export function planBounds(plan: FramePlan, measure?: LineMeasurer): ElementBounds[] {
  const canvas = { width: plan.width, height: plan.height };
  return plan.items.flatMap((item) => itemBounds(item, canvas, measure) ?? []);
}

export function pointInBounds(b: ElementBounds, x: number, y: number): boolean {
  const rad = (-b.rotationDegrees * Math.PI) / 180;
  const dx = x - b.cx;
  const dy = y - b.cy;
  const lx = dx * Math.cos(rad) - dy * Math.sin(rad);
  const ly = dx * Math.sin(rad) + dy * Math.cos(rad);
  return Math.abs(lx) <= b.width / 2 && Math.abs(ly) <= b.height / 2;
}

/** Topmost element at a canvas point (items are in draw order, so search from the end). */
export function hitTest(bounds: ReadonlyArray<ElementBounds>, x: number, y: number): ElementBounds | null {
  for (let i = bounds.length - 1; i >= 0; i--) {
    const b = bounds[i] as ElementBounds;
    if (pointInBounds(b, x, y)) return b;
  }
  return null;
}
