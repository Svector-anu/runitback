import type { FramePlan, LayerSource } from "#/engine/render";
import type { MaskFrame } from "#/engine/segmentation";
import type { FrameSources } from "#/render/compositor";
import { sharedMaskProvider, type MaskProvider } from "./segmentation/mask-provider";
import type { VideoFrameCache } from "./video-frames";

type VisualSource = Extract<LayerSource, { type: "video" | "image" }>;

const key = (s: VisualSource): string => (s.type === "video" ? `v:${s.mediaId}@${s.sourceSeconds}` : `i:${s.mediaId}`);

/** Decoded images by media id; bitmaps are closed when the asset is released. */
export class ImageCache {
  private readonly bitmaps = new Map<string, Promise<ImageBitmap | null>>();

  constructor(private readonly getBlob: (mediaId: string) => Blob | undefined) {}

  get size(): number {
    return this.bitmaps.size;
  }

  get(mediaId: string): Promise<ImageBitmap | null> {
    let entry = this.bitmaps.get(mediaId);
    if (!entry) {
      const blob = this.getBlob(mediaId);
      entry = blob ? createImageBitmap(blob).catch(() => null) : Promise.resolve(null);
      this.bitmaps.set(mediaId, entry);
    }
    return entry;
  }

  async release(mediaId: string): Promise<void> {
    const entry = this.bitmaps.get(mediaId);
    this.bitmaps.delete(mediaId);
    (await entry)?.close();
  }

  async dispose(): Promise<void> {
    await Promise.all([...this.bitmaps.keys()].map((k) => this.release(k)));
  }
}

/** Feeds the compositor from the video-frame and image caches. */
export class CachedFrameSources implements FrameSources {
  private frames = new Map<string, CanvasImageSource>();

  constructor(private readonly video: VideoFrameCache, private readonly images: ImageCache, private readonly masksOverride?: MaskProvider) {}

  private get masks(): MaskProvider | null {
    return this.masksOverride ?? sharedMaskProvider();
  }

  async prepare(plan: FramePlan): Promise<void> {
    const wanted = new Map<string, VisualSource>();
    for (const item of plan.items) {
      if ((item.kind === "layer" || item.kind === "blurBackground") && item.source.type !== "graphic") {
        wanted.set(key(item.source), item.source);
      }
    }
    const positionsPerMedia = new Map<string, number>();
    for (const source of wanted.values()) if (source.type === "video") positionsPerMedia.set(source.mediaId, (positionsPerMedia.get(source.mediaId) ?? 0) + 1);
    const next = new Map<string, CanvasImageSource>();
    await Promise.all([...wanted].map(async ([k, source]) => {
      const image = source.type === "video"
        ? await this.video.getFrame(source.mediaId, source.sourceSeconds, { exclusive: positionsPerMedia.get(source.mediaId) === 1 })
        : await this.images.get(source.mediaId);
      if (image) next.set(k, image);
    }));
    this.frames = next;
    if (this.masks) {
      const needed = new Set<string>();
      for (const item of plan.items) {
        if (item.kind === "layer" && item.source.type !== "graphic" && item.effects.some((e) => e.type === "remove-background")) needed.add(item.source.mediaId);
      }
      await Promise.all([...needed].map((id) => this.masks?.ensure(id)));
    }
  }

  mask(source: VisualSource): MaskFrame | null {
    return this.masks?.get(source.mediaId, source.type === "video" ? source.sourceSeconds : 0) ?? null;
  }

  get(source: VisualSource): CanvasImageSource | null {
    return this.frames.get(key(source)) ?? null;
  }
}
