import { transitionLook, type DrawItem, type FramePlan } from "#/engine/render";

/** A source drawn at 95% of its decoded size or more is decoded at full size: resampling for a 5% saving is not worth it. */
const NATIVE_SNAP = 0.95;
/** Never decode below this fraction of the source, so a tiny picture-in-picture stays recognisable if later enlarged by effects. */
const MIN_DECODE_SCALE = 0.1;

/** Source pixels needed per canvas pixel for one drawn layer, as drawn size over source size (crop cancels out). */
function drawnFraction(item: DrawItem, canvas: { width: number; height: number }): { mediaId: string; fraction: number } | null {
  if (item.kind === "blurBackground") {
    const { source } = item;
    if (source.type !== "video") return null;
    return { mediaId: source.mediaId, fraction: Math.max(canvas.width / source.width, canvas.height / source.height) };
  }
  if (item.kind !== "layer" || item.source.type !== "video") return null;
  const scale = item.transition ? transitionLook(item.transition).scale : 1;
  const { width, height } = item.transform;
  return { mediaId: item.source.mediaId, fraction: Math.max((width * scale) / item.source.width, (height * scale) / item.source.height) };
}

/**
 * The most each video source is ever drawn at relative to its own size, over every frame of an export. A source never
 * drawn larger than this can be decoded at that fraction of its size without losing detail in the output.
 */
export class DecodeScales {
  private readonly largest = new Map<string, number>();

  observe(plan: FramePlan): void {
    for (const item of plan.items) {
      const drawn = drawnFraction(item, plan);
      if (drawn && Number.isFinite(drawn.fraction)) this.largest.set(drawn.mediaId, Math.max(this.largest.get(drawn.mediaId) ?? 0, drawn.fraction));
    }
  }

  /** Fraction of the source's size to decode at, 1 for full size; 1 for sources never observed. */
  scaleFor(mediaId: string): number {
    const fraction = this.largest.get(mediaId);
    if (fraction === undefined || fraction >= NATIVE_SNAP) return 1;
    return Math.max(MIN_DECODE_SCALE, fraction);
  }
}
