import { VideoFrameCache } from "#/platform/video-frames";
import type { ImagePixels } from "./protocol";

/** Decoded frames of one video as small RGBA bitmaps. */
export interface FrameSource {
  /** The frame showing at `seconds`, or null when none could be decoded. */
  frameAt(seconds: number): Promise<ImagePixels | null>;
  dispose(): Promise<void>;
}

/** The image model looks at a 224 px picture, so a larger frame is only extra bytes to copy to the worker. */
export const TARGET_SHORT_EDGE = 224;

const MEDIA_KEY = "visual";

function toPixels(frame: CanvasImageSource): ImagePixels | null {
  const { width, height } = frame as { width: number; height: number };
  if (!(width > 0) || !(height > 0)) return null;
  const scale = Math.min(1, TARGET_SHORT_EDGE / Math.min(width, height));
  const w = Math.max(1, Math.round(width * scale));
  const h = Math.max(1, Math.round(height * scale));
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(frame, 0, 0, w, h);
  const image = ctx.getImageData(0, 0, w, h);
  return { width: w, height: h, data: image.data };
}

/** Reuses the preview's frame decoder (`VideoFrameCache`: forward iteration within 2 s, else seek); ask for ascending times. */
export function openVideoFrames(blob: Blob): FrameSource {
  const cache = new VideoFrameCache(() => blob);
  return {
    async frameAt(seconds) {
      const frame = await cache.getFrame(MEDIA_KEY, seconds);
      return frame ? toPixels(frame) : null;
    },
    dispose: () => cache.dispose(),
  };
}
