import { ALL_FORMATS, AudioBufferSink, BlobSource, CanvasSink, Input } from "mediabunny";
import {
  MEDIA_ANALYSIS_VERSION, RmsAccumulator, analyzeShots, detectOnsets, detectSceneCuts, detectSilence, detectSpeechLikeRanges,
  estimateTempo, frameSignature, levelCurve, locateCut, loudnessStats, type MediaAnalysis, type SceneCut, type TimedSignature,
} from "#/engine/analysis";
import type { MediaAssetInfo } from "#/engine/model";
import { analysisCacheKey, type AnalysisStore } from "./store";

export const DEFAULT_ANALYSIS_SAMPLE_FPS = 4;
export const MAX_ANALYSIS_FRAMES = 1200;
export const SIGNATURE_FRAME_WIDTH = 64;
export const SIGNATURE_FRAME_HEIGHT = 36;
export const CUT_REFINE_FPS = 30;
export const MAX_REFINED_CUTS = 100;

export type AnalysisPhase = "audio" | "video" | "refine" | "done";

export interface AnalysisProgress {
  phase: AnalysisPhase;
  /** 0..1 within the phase. */
  fraction: number;
  /** 0..1 across the whole analysis. */
  overall: number;
}

export interface AnalyzeMediaOptions {
  onProgress?: (progress: AnalysisProgress) => void;
  signal?: AbortSignal;
  store?: AnalysisStore;
  /** Upper bound on sampled video frames per second (default 4). */
  sampleFps?: number;
  /** Total sampled-frame cap; longer media is sampled more sparsely (default 1200). */
  maxFrames?: number;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new DOMException("Media analysis was aborted", "AbortError");
}

function pixelsOf(canvas: HTMLCanvasElement | OffscreenCanvas, scratch: OffscreenCanvas): Uint8ClampedArray {
  const ctx = scratch.getContext("2d", { willReadFrequently: true }) as OffscreenCanvasRenderingContext2D | null;
  if (!ctx) throw new Error("Canvas 2D is not available for frame analysis");
  ctx.drawImage(canvas, 0, 0, SIGNATURE_FRAME_WIDTH, SIGNATURE_FRAME_HEIGHT);
  return ctx.getImageData(0, 0, SIGNATURE_FRAME_WIDTH, SIGNATURE_FRAME_HEIGHT).data;
}

function emptyAnalysis(info: MediaAssetInfo, durationSeconds: number): MediaAnalysis {
  return {
    assetId: info.id, version: MEDIA_ANALYSIS_VERSION, durationSeconds, hasAudio: false, hasVideo: false, silences: [], loudness: null,
    speechLikeRanges: [], onsets: [], levelCurve: null, sceneCuts: [], shots: [], notes: [],
  };
}

/**
 * Measures a media file without holding it in memory: audio is streamed through 20 ms RMS windows,
 * video is sampled at <= `sampleFps` (and <= `maxFrames` in total) into 64x36 signatures.
 * Results are cached by asset id + size + lastModified when a store is given.
 */
export async function analyzeMedia(file: Blob, info: MediaAssetInfo, options: AnalyzeMediaOptions = {}): Promise<MediaAnalysis> {
  throwIfAborted(options.signal);
  const key = analysisCacheKey(info);
  const cached = await options.store?.get(key);
  if (cached && cached.version === MEDIA_ANALYSIS_VERSION) {
    options.onProgress?.({ phase: "done", fraction: 1, overall: 1 });
    return cached;
  }
  if (info.type === "image") return emptyAnalysis(info, 0);

  const report = (phase: AnalysisPhase, fraction: number, weights: { start: number; span: number }): void =>
    options.onProgress?.({ phase, fraction, overall: weights.start + weights.span * Math.min(1, Math.max(0, fraction)) });

  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  try {
    const durationSeconds = await input.computeDuration();
    const audioTrack = await input.getPrimaryAudioTrack();
    const videoTrack = info.type === "video" ? await input.getPrimaryVideoTrack() : null;
    const hasAudio = audioTrack !== null && (await audioTrack.canDecode());
    const hasVideo = videoTrack !== null && (await videoTrack.canDecode());
    const result = { ...emptyAnalysis(info, durationSeconds), hasAudio, hasVideo };
    const audioWeights = { start: 0, span: hasVideo ? 0.4 : 0.95 };
    const videoWeights = { start: hasAudio ? 0.4 : 0, span: hasAudio ? 0.5 : 0.9 };
    const refineWeights = { start: 0.9, span: 0.1 };

    if (audioTrack && hasAudio) {
      const sink = new AudioBufferSink(audioTrack);
      const accumulator = new RmsAccumulator();
      for await (const wrapped of sink.buffers()) {
        throwIfAborted(options.signal);
        const channels = Array.from({ length: wrapped.buffer.numberOfChannels }, (_, c) => wrapped.buffer.getChannelData(c));
        accumulator.push({ channels, sampleRate: wrapped.buffer.sampleRate, startSeconds: wrapped.timestamp });
        report("audio", durationSeconds > 0 ? (wrapped.timestamp + wrapped.duration) / durationSeconds : 1, audioWeights);
      }
      const windows = accumulator.finish();
      result.silences = detectSilence({ windows }).map((s) => ({ ...s, end: Math.min(s.end, durationSeconds) }));
      result.loudness = loudnessStats(windows);
      result.speechLikeRanges = detectSpeechLikeRanges(windows);
      result.onsets = detectOnsets(windows);
      const tempo = estimateTempo(result.onsets);
      if (tempo) {
        result.tempoBpm = tempo.bpm;
        result.tempoConfidence = tempo.confidence;
      }
      result.levelCurve = levelCurve(windows);
    }

    if (videoTrack && hasVideo) {
      const sink = new CanvasSink(videoTrack, { width: SIGNATURE_FRAME_WIDTH, height: SIGNATURE_FRAME_HEIGHT, fit: "fill" });
      const scratch = new OffscreenCanvas(SIGNATURE_FRAME_WIDTH, SIGNATURE_FRAME_HEIGHT);
      const requestedFps = options.sampleFps ?? DEFAULT_ANALYSIS_SAMPLE_FPS;
      const maxFrames = options.maxFrames ?? MAX_ANALYSIS_FRAMES;
      const step = Math.max(1 / requestedFps, durationSeconds / maxFrames);
      if (step > 1 / requestedFps + 1e-9) result.notes.push(`Video sampled every ${step.toFixed(2)}s (frame cap ${maxFrames}); short shots may be missed.`);
      const times: number[] = [];
      for (let t = 0; t < durationSeconds; t += step) times.push(t);

      const samples: TimedSignature[] = [];
      let index = 0;
      for await (const wrapped of sink.canvasesAtTimestamps(times)) {
        throwIfAborted(options.signal);
        index++;
        if (wrapped && wrapped.timestamp !== samples[samples.length - 1]?.time) {
          samples.push({ time: wrapped.timestamp, signature: frameSignature(pixelsOf(wrapped.canvas, scratch), SIGNATURE_FRAME_WIDTH, SIGNATURE_FRAME_HEIGHT) });
        }
        report("video", index / times.length, videoWeights);
      }

      const coarse = detectSceneCuts(samples);
      const refined: SceneCut[] = [];
      let refinedCount = 0;
      for (const cut of coarse) {
        throwIfAborted(options.signal);
        const position = samples.findIndex((s) => s.time === cut.time);
        const before = samples[position - 1];
        if (!before || refinedCount >= MAX_REFINED_CUTS) {
          refined.push(cut);
          continue;
        }
        refinedCount++;
        const fineTimes: number[] = [];
        for (let t = before.time; t < cut.time; t += 1 / CUT_REFINE_FPS) fineTimes.push(t);
        const dense: TimedSignature[] = [before];
        for await (const wrapped of sink.canvasesAtTimestamps(fineTimes.slice(1))) {
          if (wrapped && wrapped.timestamp > (dense[dense.length - 1] as TimedSignature).time && wrapped.timestamp < cut.time) {
            dense.push({ time: wrapped.timestamp, signature: frameSignature(pixelsOf(wrapped.canvas, scratch), SIGNATURE_FRAME_WIDTH, SIGNATURE_FRAME_HEIGHT) });
          }
        }
        dense.push(samples[position] as TimedSignature);
        refined.push(locateCut(dense) ?? cut);
        report("refine", refined.length / coarse.length, refineWeights);
      }
      if (refinedCount >= MAX_REFINED_CUTS && coarse.length > MAX_REFINED_CUTS) result.notes.push(`Only the first ${MAX_REFINED_CUTS} cuts were refined to frame accuracy.`);
      result.sceneCuts = refined;
      result.shots = analyzeShots({ samples, cuts: refined, durationSeconds });
    }

    await options.store?.put(key, result);
    report("done", 1, { start: 0, span: 1 });
    return result;
  } finally {
    input.dispose();
  }
}
