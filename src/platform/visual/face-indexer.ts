import { FACE_INDEX_VERSION, type FaceDetections, type FaceFrame, type FaceIndexer } from "#/engine/face";
import { planFrameTimes } from "#/engine/visual";
import { createFaceWorkerBackend } from "./face-worker-backend";
import type { FaceBackend, FrameInput } from "./face-protocol";
import { openVideoFrames, type FrameSource } from "./frame-source";
import { NoVideoError, type Footage } from "./indexer";

/** MediaPipe BlazeFace short range (Apache-2.0, 230 KB): faces within about two metres of the camera. */
export const DEFAULT_FACE_MODEL = "mediapipe/blaze_face_short_range";

/** Frames per worker message: large enough to amortise the round trip, small enough that cancel and progress stay responsive. */
export const FACE_FRAME_BATCH_SIZE = 8;

export interface FaceIndexerOptions {
  /** The imported media file for an asset, or undefined when it is unknown. */
  getVideo(assetId: string): Blob | undefined;
  getFootage(assetId: string): Promise<Footage>;
  model?: string;
  intervalSeconds?: number;
  maxFrames?: number;
  /** Test seam: replaces the worker-backed detector. */
  createBackend?: () => FaceBackend;
  /** Test seam: replaces mediabunny decoding. */
  openFrames?: (blob: Blob) => FrameSource;
}

const abortError = (): DOMException => new DOMException("Face indexing was aborted", "AbortError");

/**
 * Local face detection. Samples frames exactly as the CLIP indexer does (`planFrameTimes`, `VideoFrameCache` decoding),
 * detects faces in batches in a worker and returns plain boxes per frame. Nothing is uploaded.
 */
export function createFaceIndexer(options: FaceIndexerOptions): FaceIndexer {
  const model = options.model ?? DEFAULT_FACE_MODEL;
  const createBackend = options.createBackend ?? createFaceWorkerBackend;
  const openFrames = options.openFrames ?? openVideoFrames;
  return {
    async index({ assetId, signal, onProgress }): Promise<FaceDetections> {
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

      const backend = createBackend();
      const source = openFrames(blob);
      const onAbort = (): void => backend.dispose();
      signal?.addEventListener("abort", onAbort, { once: true });
      try {
        const frames: FaceFrame[] = [];
        const detectBatch = async (batch: FrameInput[]): Promise<void> => {
          if (signal?.aborted) throw abortError();
          const detected = await backend.detect({ frames: batch });
          if (detected.length !== batch.length) throw new Error(`The detector returned ${detected.length} results for ${batch.length} frames`);
          frames.push(...detected);
          onProgress?.(Math.min(1, frames.length / plan.length));
        };

        let batch: FrameInput[] = [];
        let visited = 0;
        for (const time of plan) {
          if (signal?.aborted) throw abortError();
          const pixels = await source.frameAt(time);
          visited += 1;
          if (pixels) batch.push({ time, pixels });
          if (batch.length === FACE_FRAME_BATCH_SIZE || (visited === plan.length && batch.length > 0)) {
            await detectBatch(batch);
            batch = [];
          }
        }
        if (frames.length === 0) throw new NoVideoError();
        onProgress?.(1);
        return { version: FACE_INDEX_VERSION, assetId, model, durationSeconds: footage.durationSeconds, frames };
      } catch (error) {
        if (signal?.aborted) throw abortError();
        throw error;
      } finally {
        signal?.removeEventListener("abort", onAbort);
        backend.dispose();
        await source.dispose();
      }
    },
  };
}
