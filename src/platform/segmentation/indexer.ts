import { MASK_TRACK_VERSION, planMaskTimes, type MaskTrack } from "#/engine/segmentation";
import { VideoFrameCache } from "#/platform/video-frames";
import type { ImagePixels } from "#/platform/visual/protocol";
import { createSegmentWorkerBackend } from "./worker-backend";
import type { SegmentBackend, SegmentFrameInput, SegmenterModelId } from "./protocol";

/** Longest edge, in pixels, of the pictures fed to the model (it works at 256 px; more only costs copies). */
export const SEGMENT_MAX_EDGE = 384;
export const SEGMENT_BATCH_SIZE = 6;

/** MediaPipe Selfie Segmenter (256x256) and its 16:9 landscape variant: float16 .tflite, about 250 KB each. */
export const SEGMENTER_MODELS: Record<SegmenterModelId, string> = {
  selfie_segmenter: "mediapipe/selfie_segmenter",
  selfie_segmenter_landscape: "mediapipe/selfie_segmenter_landscape",
};

export const modelFor = (width: number, height: number): SegmenterModelId => (width >= height * 1.3 ? "selfie_segmenter_landscape" : "selfie_segmenter");

export interface SegmentFrames {
  /** The frame showing at `seconds` (any time for a still image), or null when none could be decoded. */
  frameAt(seconds: number): Promise<ImagePixels | null>;
  dispose(): Promise<void>;
}

export interface SegmentationInput {
  assetId: string;
  blob: Blob;
  kind: "video" | "image";
  width: number;
  height: number;
  durationSeconds: number;
  fps?: number;
}

export interface SegmentationIndexerOptions {
  /** Test seam: replaces the worker-backed model. */
  createBackend?: () => SegmentBackend;
  /** Test seam: replaces decoding. */
  openFrames?: (input: SegmentationInput) => SegmentFrames;
}

const abortError = (): DOMException => new DOMException("Background analysis was aborted", "AbortError");

function toPixels(frame: CanvasImageSource, maxEdge: number): ImagePixels | null {
  const { width, height } = frame as { width: number; height: number };
  if (!(width > 0) || !(height > 0)) return null;
  const scale = Math.min(1, maxEdge / Math.max(width, height));
  const w = Math.max(1, Math.round(width * scale)), h = Math.max(1, Math.round(height * scale));
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(frame, 0, 0, w, h);
  return { width: w, height: h, data: ctx.getImageData(0, 0, w, h).data };
}

export function openSegmentFrames(input: SegmentationInput): SegmentFrames {
  if (input.kind === "image") {
    const bitmap = createImageBitmap(input.blob);
    return {
      async frameAt() { return toPixels(await bitmap, SEGMENT_MAX_EDGE); },
      async dispose() { (await bitmap).close(); },
    };
  }
  const cache = new VideoFrameCache(() => input.blob, { maxEdge: SEGMENT_MAX_EDGE });
  return {
    async frameAt(seconds) {
      const frame = await cache.getFrame("segment", seconds);
      return frame ? toPixels(frame, SEGMENT_MAX_EDGE) : null;
    },
    dispose: () => cache.dispose(),
  };
}

/**
 * Local person segmentation of a whole asset: decodes frames at the sampling rate, runs the model in a worker in small
 * batches (so progress and cancel stay responsive) and returns one 8-bit confidence mask per sampled frame.
 */
export function createSegmentationIndexer(options: SegmentationIndexerOptions = {}) {
  const createBackend = options.createBackend ?? createSegmentWorkerBackend;
  const openFrames = options.openFrames ?? openSegmentFrames;
  return {
    async index(input: SegmentationInput & { signal?: AbortSignal; onProgress?: (fraction: number) => void }): Promise<MaskTrack> {
      if (input.signal?.aborted) throw abortError();
      const times = planMaskTimes({ durationSeconds: input.durationSeconds, ...(input.fps === undefined ? {} : { fps: input.fps }), isStill: input.kind === "image" });
      const modelId = modelFor(input.width, input.height);
      const backend = createBackend();
      const source = openFrames(input);
      const onAbort = (): void => backend.dispose();
      input.signal?.addEventListener("abort", onAbort, { once: true });
      try {
        const keptTimes: number[] = [];
        const frames: Uint8Array[] = [];
        let width = 0, height = 0;
        const run = async (batch: SegmentFrameInput[]): Promise<void> => {
          if (input.signal?.aborted) throw abortError();
          const out = await backend.segment({ model: modelId, frames: batch });
          if (out.length !== batch.length) throw new Error(`The segmenter returned ${out.length} masks for ${batch.length} frames`);
          for (const frame of out) {
            if (width === 0) { width = frame.width; height = frame.height; }
            if (frame.width !== width || frame.height !== height) throw new Error("The segmenter changed its mask size mid-clip");
            keptTimes.push(frame.time);
            frames.push(frame.data);
          }
          input.onProgress?.(Math.min(1, keptTimes.length / times.length));
        };
        let batch: SegmentFrameInput[] = [];
        for (const [index, time] of times.entries()) {
          if (input.signal?.aborted) throw abortError();
          const pixels = await source.frameAt(time);
          if (pixels) batch.push({ time, pixels });
          if (batch.length === SEGMENT_BATCH_SIZE || (index === times.length - 1 && batch.length > 0)) {
            await run(batch);
            batch = [];
          }
        }
        if (frames.length === 0) throw new Error("No frames could be decoded from this media");
        input.onProgress?.(1);
        return { version: MASK_TRACK_VERSION, assetId: input.assetId, model: SEGMENTER_MODELS[modelId], width, height, times: keptTimes, frames, durationSeconds: input.durationSeconds };
      } catch (error) {
        if (input.signal?.aborted) throw abortError();
        throw error;
      } finally {
        input.signal?.removeEventListener("abort", onAbort);
        backend.dispose();
        await source.dispose();
      }
    },
  };
}
