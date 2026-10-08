import { VISUAL_INDEX_VERSION, planFrameTimes, type VisualEmbeddings, type VisualIndexer } from "#/engine/visual";
import type { FrameSource } from "./frame-source";
import { openVideoFrames } from "./frame-source";
import type { ClipBackend, ImagePixels } from "./protocol";
import { createWorkerBackend } from "./worker-backend";

/**
 * CLIP ViT-B/32 (OpenAI, MIT) as exported for transformers.js. Int8 weights: image half 89 MB, text half 65 MB,
 * tokenizer 2 MB. Chosen over SigLIP-base (Apache-2.0, 205 MB) and MobileCLIP (Apple licence) for size and licence.
 */
export const DEFAULT_CLIP_MODEL = "Xenova/clip-vit-base-patch32";

/** Frames per worker message: large enough to amortise the round trip, small enough that cancel and progress stay responsive. */
export const FRAME_BATCH_SIZE = 8;
/** Share of the progress bar given to loading (and, the first time, downloading) the model. */
const LOAD_PROGRESS_SHARE = 0.3;

export interface Footage {
  durationSeconds: number;
  /** Scene cuts in source seconds; empty when the asset has not been analysed. */
  cutTimes: number[];
}

export interface ClipIndexerOptions {
  /** The imported media file for an asset, or undefined when it is unknown. */
  getVideo(assetId: string): Blob | undefined;
  getFootage(assetId: string): Promise<Footage>;
  model?: string;
  intervalSeconds?: number;
  maxFrames?: number;
  /** Test seam: replaces the worker-backed model. */
  createBackend?: (model: string) => ClipBackend;
  /** Test seam: replaces mediabunny decoding. */
  openFrames?: (blob: Blob) => FrameSource;
}

export class NoVideoError extends Error {
  constructor() {
    super("This media has no video frames to index");
    this.name = "NoVideoError";
  }
}

const abortError = (): DOMException => new DOMException("Visual indexing was aborted", "AbortError");

/**
 * Local visual indexing. Picks frames (one per shot midpoint plus one every few seconds, capped), decodes them with
 * the preview's frame decoder, embeds them in batches in a worker and returns normalised vectors. Nothing is uploaded.
 */
export function createClipIndexer(options: ClipIndexerOptions): VisualIndexer {
  const model = options.model ?? DEFAULT_CLIP_MODEL;
  const createBackend = options.createBackend ?? createWorkerBackend;
  const openFrames = options.openFrames ?? openVideoFrames;
  return {
    async index({ assetId, signal, onProgress }): Promise<VisualEmbeddings> {
      if (signal?.aborted) throw abortError();
      const blob = options.getVideo(assetId);
      if (!blob) throw new Error(`Media for asset ${assetId} is not loaded`);
      const footage = await options.getFootage(assetId);
      const plan = planFrameTimes({
        durationSeconds: footage.durationSeconds, cutTimes: footage.cutTimes,
        ...(options.intervalSeconds === undefined ? {} : { intervalSeconds: options.intervalSeconds }),
        ...(options.maxFrames === undefined ? {} : { maxFrames: options.maxFrames }),
      });
      if (plan.length === 0) throw new NoVideoError();

      const backend = createBackend(model);
      const frames = openFrames(blob);
      const onAbort = (): void => backend.dispose();
      signal?.addEventListener("abort", onAbort, { once: true });
      try {
        const times: number[] = [];
        const rows: Float32Array[] = [];
        let loaded = 0;
        let reported = 0;
        const report = (framesDone: number): void => {
          reported = Math.max(reported, Math.min(1, LOAD_PROGRESS_SHARE * loaded + (1 - LOAD_PROGRESS_SHARE) * (framesDone / plan.length)));
          onProgress?.(reported);
        };
        const embedBatch = async (batch: Array<{ time: number; pixels: ImagePixels }>): Promise<void> => {
          if (signal?.aborted) throw abortError();
          const vectors = await backend.embedImages({ images: batch.map((b) => b.pixels), onLoad: (fraction) => { loaded = Math.max(loaded, fraction); report(times.length); } });
          if (vectors.length !== batch.length) throw new Error(`The model returned ${vectors.length} embeddings for ${batch.length} frames`);
          batch.forEach((b, i) => { times.push(b.time); rows.push(vectors[i] as Float32Array); });
          loaded = 1;
          report(times.length);
        };

        let batch: Array<{ time: number; pixels: ImagePixels }> = [];
        let visited = 0;
        for (const time of plan) {
          if (signal?.aborted) throw abortError();
          const pixels = await frames.frameAt(time);
          visited += 1;
          if (pixels) batch.push({ time, pixels });
          if (batch.length === FRAME_BATCH_SIZE || (visited === plan.length && batch.length > 0)) {
            await embedBatch(batch);
            batch = [];
          }
        }
        const dimensions = rows[0]?.length;
        if (!dimensions) throw new NoVideoError();
        const vectors = new Float32Array(rows.length * dimensions);
        rows.forEach((row, i) => vectors.set(row, i * dimensions));
        onProgress?.(1);
        return {
          version: VISUAL_INDEX_VERSION, assetId, model, dimensions, durationSeconds: footage.durationSeconds,
          cuts: footage.cutTimes.filter((c) => c > 0 && c < footage.durationSeconds), times, vectors,
        };
      } catch (error) {
        if (signal?.aborted) throw abortError();
        throw error;
      } finally {
        signal?.removeEventListener("abort", onAbort);
        backend.dispose();
        await frames.dispose();
      }
    },
  };
}
