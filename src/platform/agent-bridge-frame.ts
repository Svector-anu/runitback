import { currentScene, type EditorDocument } from "#/engine/commands";
import { buildFramePlan } from "#/engine/render";
import { TICKS_PER_SECOND, clampTime, lastFrameTime, mediaTimeFromSeconds, roundToFrame } from "#/engine/time";
import { totalDuration } from "#/engine/timeline";
import { Compositor } from "#/render/compositor";
import { context2d, createCanvas, type AnyCanvas } from "#/render/canvas";
import { CachedFrameSources } from "./frame-sources";
import type { MediaRuntime } from "./media-runtime";

export const DEFAULT_FRAME_MAX_SIZE = 1024;
export const MAX_FRAME_MAX_SIZE = 2048;
const JPEG_QUALITY = 0.85;

export interface RenderedFrame {
  base64: string;
  width: number;
  height: number;
  /** The time actually rendered, in seconds, after clamping to the timeline and snapping to a frame. */
  seconds: number;
}

async function canvasToJpeg(canvas: AnyCanvas): Promise<Blob> {
  if (canvas instanceof OffscreenCanvas) return canvas.convertToBlob({ type: "image/jpeg", quality: JPEG_QUALITY });
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", JPEG_QUALITY));
  if (!blob) throw new Error("Could not encode the frame as JPEG");
  return blob;
}

export async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(binary);
}

/**
 * Renders one composed frame through the same plan + compositor the preview and export use, scaled so its long
 * side is at most `maxSize`. Uses private frame sources so it never races the live preview's cache.
 */
export async function renderFrameJpeg(input: { doc: EditorDocument; runtime: MediaRuntime; seconds: number; maxSize?: number }): Promise<RenderedFrame> {
  const { doc, runtime } = input;
  const tracks = currentScene(doc).tracks;
  const size = doc.settings.canvasSize;
  const duration = totalDuration(tracks);
  const last = duration > 0 ? lastFrameTime(duration, doc.settings.fps) : mediaTimeFromSeconds(0);
  const time = roundToFrame(clampTime(mediaTimeFromSeconds(input.seconds), 0, last), doc.settings.fps);
  const full = createCanvas(size.width, size.height);
  const plan = buildFramePlan({ tracks, canvas: size, background: doc.settings.background, assets: doc.assets, time });
  await new Compositor(full).render(plan, new CachedFrameSources(runtime.video, runtime.images));

  const maxSize = Math.min(MAX_FRAME_MAX_SIZE, Math.max(16, Math.round(input.maxSize ?? DEFAULT_FRAME_MAX_SIZE)));
  const scale = Math.min(1, maxSize / Math.max(full.width, full.height));
  const width = Math.max(1, Math.round(full.width * scale));
  const height = Math.max(1, Math.round(full.height * scale));
  const out = createCanvas(width, height);
  const ctx = context2d(out);
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(full as CanvasImageSource, 0, 0, width, height);
  return { base64: await blobToBase64(await canvasToJpeg(out)), width, height, seconds: time / TICKS_PER_SECOND };
}
