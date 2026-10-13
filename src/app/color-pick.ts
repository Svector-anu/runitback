import type { ElementRef } from "#/engine/model";
import { canvasPointToSourceUv, type FramePlan, type MediaLayer } from "#/engine/render";
import { context2d, createCanvas } from "#/render/canvas";
import { Store } from "./store";
import { getServices } from "./services";

export interface ColorPickTarget {
  ref: ElementRef;
  effectId: string;
}

/** The effect parameter currently waiting for a colour picked from the preview, or null. */
export const colorPickStore = new Store<{ target: ColorPickTarget | null }>({ target: null });

const SAMPLE_RADIUS = 2;

const hex = (n: number): string => Math.round(n).toString(16).padStart(2, "0");

/**
 * The average colour of the clip's own source frame (before any effect) under a canvas point of the last rendered
 * plan, or null when the point is outside the clip. Averaging a small patch ignores single-pixel sensor noise.
 */
export function sampleSourceColor(input: { plan: FramePlan; elementId: string; point: { x: number; y: number } }): string | null {
  const layer = input.plan.items.find((i): i is MediaLayer => i.kind === "layer" && i.elementId === input.elementId);
  if (!layer || layer.source.type === "graphic") return null;
  const uv = canvasPointToSourceUv({ transform: layer.transform, crop: layer.crop, point: input.point });
  if (!uv) return null;
  const image = getServices().runtime.frameSources.get(layer.source);
  if (!image) return null;
  const size = SAMPLE_RADIUS * 2 + 1;
  const canvas = createCanvas(size, size);
  const ctx = context2d(canvas);
  const sx = uv.u * layer.source.width - SAMPLE_RADIUS;
  const sy = uv.v * layer.source.height - SAMPLE_RADIUS;
  ctx.drawImage(image, sx, sy, size, size, 0, 0, size, size);
  const data = ctx.getImageData(0, 0, size, size).data;
  let r = 0, g = 0, b = 0, n = 0;
  for (let i = 0; i < data.length; i += 4) {
    if ((data[i + 3] ?? 0) === 0) continue;
    r += data[i] as number; g += data[i + 1] as number; b += data[i + 2] as number; n++;
  }
  return n === 0 ? null : `#${hex(r / n)}${hex(g / n)}${hex(b / n)}`;
}
