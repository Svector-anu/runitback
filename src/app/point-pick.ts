import { canvasPointToSourceUv, type FramePlan, type MediaLayer } from "#/engine/render";
import { Store } from "./store";

/** The clip waiting for the user to click a point to follow in the preview, or null. */
export const pointPickStore = new Store<{ targetElementId: string | null }>({ targetElementId: null });

/** The topmost video layer under a canvas point (other than `excludeElementId`) and where in its picture the point is, as 0..1 fractions. */
export function findVideoUnder(input: { plan: FramePlan; excludeElementId: string; point: { x: number; y: number } }): { elementId: string; u: number; v: number } | null {
  const layers = input.plan.items.filter((i): i is MediaLayer => i.kind === "layer" && i.source.type === "video" && i.elementId !== input.excludeElementId);
  for (const layer of [...layers].reverse()) {
    const uv = canvasPointToSourceUv({ transform: layer.transform, crop: layer.crop, point: input.point });
    if (uv) return { elementId: layer.elementId, u: uv.u, v: uv.v };
  }
  return null;
}
