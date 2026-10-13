import type { LumaFrame, MotionSample, TrackSample } from "#/engine/tracking";
import { VideoFrameCache } from "#/platform/video-frames";
import { createTrackingWorkerBackend } from "./worker-backend";
import type { TrackingBackend } from "./protocol";

/** Longest edge of the analysis pictures: motion is measured here and scaled back, so a pixel here is several in a 1080p frame. */
export const TRACK_MAX_EDGE = 320;
/** Hard cap on analysed frames (30 s at 30 fps); longer ranges are rejected rather than silently thinned. */
export const TRACK_MAX_FRAMES = 900;

export interface LumaSource {
  /** Greyscale analysis picture of the frame showing at `seconds`, or null when none could be decoded. */
  frameAt(seconds: number): Promise<LumaFrame | null>;
  dispose(): Promise<void>;
}

export interface MotionInput {
  blob: Blob;
  /** Source seconds to analyse, ascending. */
  times: number[];
  signal?: AbortSignal;
  onProgress?: (fraction: number) => void;
}

export interface TrackAnalysis {
  /** Analysis picture size the positions are measured in. */
  width: number;
  height: number;
  samples: TrackSample[];
}

export interface CameraAnalysis {
  width: number;
  height: number;
  path: MotionSample[];
}

export interface MotionAnalyzerOptions {
  createBackend?: () => TrackingBackend;
  openFrames?: (blob: Blob) => LumaSource;
}

const abortError = (): DOMException => new DOMException("Motion analysis was aborted", "AbortError");

function toLuma(frame: CanvasImageSource): LumaFrame | null {
  const { width, height } = frame as { width: number; height: number };
  if (!(width > 0) || !(height > 0)) return null;
  const scale = Math.min(1, TRACK_MAX_EDGE / Math.max(width, height));
  const w = Math.max(1, Math.round(width * scale)), h = Math.max(1, Math.round(height * scale));
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(frame, 0, 0, w, h);
  const rgba = ctx.getImageData(0, 0, w, h).data;
  const data = new Uint8Array(w * h);
  for (let i = 0, j = 0; i < data.length; i++, j += 4) data[i] = Math.round(0.299 * (rgba[j] as number) + 0.587 * (rgba[j + 1] as number) + 0.114 * (rgba[j + 2] as number));
  return { width: w, height: h, data };
}

export function openLumaFrames(blob: Blob): LumaSource {
  const cache = new VideoFrameCache(() => blob, { maxEdge: TRACK_MAX_EDGE });
  return {
    async frameAt(seconds) {
      const frame = await cache.getFrame("motion", seconds);
      return frame ? toLuma(frame) : null;
    },
    dispose: () => cache.dispose(),
  };
}

/** Local motion analysis: decodes greyscale frames at the requested source times, then tracks or measures camera motion in a worker. Nothing is uploaded. */
export function createMotionAnalyzer(options: MotionAnalyzerOptions = {}) {
  const createBackend = options.createBackend ?? createTrackingWorkerBackend;
  const openFrames = options.openFrames ?? openLumaFrames;

  async function collect(input: MotionInput): Promise<LumaFrame[]> {
    if (input.times.length < 2) throw new Error("Motion analysis needs at least two frames");
    if (input.times.length > TRACK_MAX_FRAMES) throw new Error(`That range is ${input.times.length} frames; the limit is ${TRACK_MAX_FRAMES}. Use a shorter range.`);
    const source = openFrames(input.blob);
    try {
      const frames: LumaFrame[] = [];
      for (const [index, time] of input.times.entries()) {
        if (input.signal?.aborted) throw abortError();
        const frame = await source.frameAt(time);
        if (!frame) throw new Error(`The frame at ${time.toFixed(2)}s could not be decoded`);
        frames.push(frame);
        input.onProgress?.(0.85 * ((index + 1) / input.times.length));
      }
      return frames;
    } finally {
      await source.dispose();
    }
  }

  async function run<T>(input: MotionInput, work: (backend: TrackingBackend, frames: LumaFrame[]) => Promise<T>): Promise<{ result: T; width: number; height: number }> {
    if (input.signal?.aborted) throw abortError();
    const frames = await collect(input);
    const backend = createBackend();
    const onAbort = (): void => backend.dispose();
    input.signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const first = frames[0] as LumaFrame;
      const result = await work(backend, frames);
      input.onProgress?.(1);
      return { result, width: first.width, height: first.height };
    } catch (error) {
      if (input.signal?.aborted) throw abortError();
      throw error;
    } finally {
      input.signal?.removeEventListener("abort", onAbort);
      backend.dispose();
    }
  }

  return {
    async track(input: MotionInput & { start: { u: number; v: number } }): Promise<TrackAnalysis> {
      const { result, width, height } = await run(input, (backend, frames) => {
        const first = frames[0] as LumaFrame;
        return backend.track({ frames, times: input.times, start: { x: input.start.u * (first.width - 1), y: input.start.v * (first.height - 1) } });
      });
      return { width, height, samples: result };
    },
    async camera(input: MotionInput): Promise<CameraAnalysis> {
      const { result, width, height } = await run(input, (backend, frames) => backend.camera({ frames, times: input.times }));
      return { width, height, path: result };
    },
  };
}
export type MotionAnalyzer = ReturnType<typeof createMotionAnalyzer>;
