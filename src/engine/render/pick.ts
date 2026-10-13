import type { LayerCrop, LayerTransform } from "./frame-plan";

/**
 * Where a canvas pixel lands in a layer's source image, as 0..1 fractions of the full (uncropped) source; null when
 * the point is outside the layer or in a cropped-away edge. Inverse of the compositor's translate/rotate/flip/scale.
 */
export function canvasPointToSourceUv(input: {
  transform: LayerTransform; crop: LayerCrop | null; point: { x: number; y: number };
}): { u: number; v: number } | null {
  const { transform: t, crop, point } = input;
  if (t.width <= 0 || t.height <= 0) return null;
  const dx = point.x - t.centerX;
  const dy = point.y - t.centerY;
  const radians = (-t.rotationDegrees * Math.PI) / 180;
  const lx = (dx * Math.cos(radians) - dy * Math.sin(radians)) * (t.flipX ? -1 : 1);
  const ly = (dx * Math.sin(radians) + dy * Math.cos(radians)) * (t.flipY ? -1 : 1);
  const u = lx / t.width + 0.5;
  const v = ly / t.height + 0.5;
  const left = crop?.left ?? 0, right = crop?.right ?? 0, top = crop?.top ?? 0, bottom = crop?.bottom ?? 0;
  if (u < left || u > 1 - right || v < top || v > 1 - bottom) return null;
  return { u, v };
}

/** Where a point of the source picture (0..1 fractions) is drawn on the canvas: the forward mapping of `canvasPointToSourceUv`. */
export function sourceUvToCanvasPoint(input: { transform: LayerTransform; uv: { u: number; v: number } }): { x: number; y: number } {
  const { transform: t, uv } = input;
  const lx = (uv.u - 0.5) * t.width * (t.flipX ? -1 : 1);
  const ly = (uv.v - 0.5) * t.height * (t.flipY ? -1 : 1);
  const radians = (t.rotationDegrees * Math.PI) / 180;
  return { x: t.centerX + lx * Math.cos(radians) - ly * Math.sin(radians), y: t.centerY + lx * Math.sin(radians) + ly * Math.cos(radians) };
}
