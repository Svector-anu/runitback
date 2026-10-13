import {
  AudioBufferSource, Mp4OutputFormat, Output, QUALITY_HIGH, QUALITY_LOW, QUALITY_MEDIUM,
  QUALITY_VERY_HIGH, VideoSample, VideoSampleSource, WebMOutputFormat, canEncodeAudio, getFirstEncodableVideoCodec, type AudioCodec, type Quality,
  type VideoCodec,
} from "mediabunny";
import { collectAudioClips } from "#/engine/audio";
import { currentScene, type EditorDocument } from "#/engine/commands";
import { documentDuration } from "#/engine/editor";
import { buildFramePlan } from "#/engine/render";
import { allElements } from "#/engine/timeline";
import { TICKS_PER_SECOND, frameRateToFloat, frameStartTime } from "#/engine/time";
import { Compositor } from "#/render/compositor";
import { createCanvas } from "#/render/canvas";
import { AudioSinkCache } from "#/platform/audio-scheduler";
import { detectCapabilities, capabilityIssues, probeEncoders } from "#/platform/capabilities";
import { CachedFrameSources, ImageCache } from "#/platform/frame-sources";
import { VideoFrameCache } from "#/platform/video-frames";
import { openAudioMix, type AudioMix } from "./audio-mix";
import { DecodeScales } from "./decode-scale";
import { createExportTarget } from "./export-target";
import { planExport, type ExportOptions } from "./plan";

export type ExportPhase = "preparing" | "audio" | "video" | "finalizing";

export interface ExportProgress {
  phase: ExportPhase;
  /** 0..1 across the whole export. */
  progress: number;
}

/** Opt-in per-stage wall time of the frame loop, in milliseconds. Pass an object to `exportProject` to fill it. */
export interface ExportTimings {
  planMs: number;
  decodeMs: number;
  composeMs: number;
  audioMs: number;
  captureMs: number;
  encodeMs: number;
  totalMs: number;
  frames: number;
  /** Forces a GPU sync after compositing so `composeMs` is real work, not queued work. Slows the export. */
  syncGpu?: boolean;
}

export function emptyExportTimings(): ExportTimings {
  return { planMs: 0, decodeMs: 0, composeMs: 0, audioMs: 0, captureMs: 0, encodeMs: 0, totalMs: 0, frames: 0 };
}

export class ExportCanceledError extends Error {
  constructor() {
    super("Export canceled");
    this.name = "ExportCanceledError";
  }
}

export class MissingMediaError extends Error {
  constructor(readonly missing: ReadonlyArray<string>) {
    super(`Cannot export: media is missing for ${missing.join(", ")}. Remove those clips or re-import the files.`);
    this.name = "MissingMediaError";
  }
}

/** Names of the media files used by visible clips whose bytes are not available. */
export function findMissingMedia(doc: EditorDocument, getBlob: (mediaId: string) => Blob | undefined): string[] {
  const names = new Map(doc.assets.map((a) => [a.id, a.name]));
  const missing = new Set<string>();
  for (const { element } of allElements(currentScene(doc).tracks)) {
    if (!("mediaId" in element) || ("hidden" in element && element.hidden === true)) continue;
    if (!names.has(element.mediaId) || !getBlob(element.mediaId)) missing.add(names.get(element.mediaId) ?? element.mediaId);
  }
  return [...missing];
}

/** How far audio runs ahead of the video frame being encoded. */
const AUDIO_LEAD_SECONDS = 1;

/** Sources are decoded up to this multiple of the output size, so zoomed-in clips stay sharp. */
const DECODE_HEADROOM = 2;

/** Decoded canvases reused per source while a media is read at one position per frame; avoids a 4K allocation per frame. */
const EXPORT_CANVAS_POOL = 4;

const QUALITIES: Record<ExportOptions["quality"], Quality> = {
  low: QUALITY_LOW, medium: QUALITY_MEDIUM, high: QUALITY_HIGH, very_high: QUALITY_VERY_HIGH,
};

export interface ExportResult {
  blob: Blob;
  mimeType: string;
  extension: string;
  width: number;
  height: number;
  frameCount: number;
  durationSeconds: number;
  hasAudio: boolean;
  videoCodec: VideoCodec;
  audioCodec: AudioCodec | null;
}

/** Says which container or size the browser can encode instead, so the message is actionable. */
async function describeNoEncoder(input: { format: ExportOptions["format"]; width: number; height: number }): Promise<string> {
  const label = input.format === "mp4" ? "MP4" : "WebM";
  const size = `${input.width}x${input.height}`;
  const other = input.format === "mp4" ? "webm" : "mp4";
  const supportAtSize = await probeEncoders({ width: input.width, height: input.height });
  if (supportAtSize[other]) return `Your browser can't encode ${label} video at ${size}. Choose ${other === "mp4" ? "MP4" : "WebM"} in the export settings.`;
  const supportAtHd = await probeEncoders({ width: 1280, height: 720 });
  if (supportAtHd.mp4 || supportAtHd.webm) return `Your browser can't encode video at ${size}. Lower the project resolution, or open RunItBack in desktop Chrome or Edge.`;
  return `Your browser can't encode ${label} video. Open RunItBack in a current Chrome, Edge, Safari or Firefox.`;
}

async function pickAudioCodec(format: ExportOptions["format"]): Promise<AudioCodec | null> {
  const candidates: AudioCodec[] = format === "mp4" ? ["aac", "opus"] : ["opus"];
  for (const codec of candidates) {
    if (await canEncodeAudio(codec)) return codec;
  }
  return null;
}

/**
 * Renders the edited timeline frame by frame through the same frame plan and compositor the preview uses,
 * mixes the audio through the same limiter, and muxes both. It never copies source media.
 */
export async function exportProject(input: {
  doc: EditorDocument;
  getBlob: (mediaId: string) => Blob | undefined;
  options: ExportOptions;
  onProgress?: (progress: ExportProgress) => void;
  signal?: AbortSignal;
  timings?: ExportTimings;
}): Promise<ExportResult> {
  const { doc, options, signal, timings } = input;
  const now = (): number => performance.now();
  const report = (phase: ExportPhase, progress: number): void => input.onProgress?.({ phase, progress });
  const throwIfCanceled = (): void => {
    if (signal?.aborted) throw new ExportCanceledError();
  };

  const plan = planExport({
    durationTicks: documentDuration(doc), fps: doc.settings.fps, canvas: doc.settings.canvasSize,
  });
  if (plan.frameCount === 0) throw new Error("There is nothing to export: the timeline is empty");
  const missingMedia = findMissingMedia(doc, input.getBlob);
  if (missingMedia.length > 0) throw new MissingMediaError(missingMedia);

  const tracks = currentScene(doc).tracks;
  const decodeScales = new DecodeScales();
  // One cheap pass over every frame plan finds how large each source is ever drawn, so it is decoded no larger.
  const planFrame = (i: number): ReturnType<typeof buildFramePlan> => buildFramePlan({
    tracks, canvas: { width: plan.width, height: plan.height }, background: doc.settings.background,
    assets: doc.assets, time: frameStartTime(i, doc.settings.fps),
  });
  for (let i = 0; i < plan.frameCount; i++) decodeScales.observe(planFrame(i));
  report("preparing", 0);
  const unsupported = capabilityIssues(detectCapabilities()).find((issue) => issue.id === "videoEncoding");
  if (unsupported) throw new Error(unsupported.message);
  const videoCodec = await getFirstEncodableVideoCodec(
    options.format === "mp4" ? ["avc", "vp9", "av1"] : ["vp9", "vp8", "av1"],
    { width: plan.width, height: plan.height, quality: QUALITIES[options.quality] },
  );
  if (!videoCodec) throw new Error(await describeNoEncoder({ format: options.format, width: plan.width, height: plan.height }));
  const audioCodec = options.includeAudio ? await pickAudioCodec(options.format) : null;

  const mimeType = options.format === "mp4" ? "video/mp4" : "video/webm";
  const exportTarget = await createExportTarget({ mimeType, extension: options.format });
  const output = new Output({
    format: options.format === "mp4" ? new Mp4OutputFormat() : new WebMOutputFormat(),
    target: exportTarget.target,
  });
  const canvas = createCanvas(plan.width, plan.height);
  const videoSource = new VideoSampleSource({ codec: videoCodec, bitrate: QUALITIES[options.quality] });
  output.addVideoTrack(videoSource, { frameRate: frameRateToFloat(doc.settings.fps) });

  const sinks = new AudioSinkCache(input.getBlob);
  const videoFrames = new VideoFrameCache(input.getBlob, {
    decodeScale: (mediaId) => decodeScales.scaleFor(mediaId), maxEdge: DECODE_HEADROOM * Math.max(plan.width, plan.height), canvasPoolSize: EXPORT_CANVAS_POOL });
  const images = new ImageCache(input.getBlob);
  let hasAudio = false;
  let audioMix: AudioMix | null = null;

  try {
    let audioSource: AudioBufferSource | null = null;
    if (audioCodec) {
      report("audio", 0.02);
      audioMix = await openAudioMix({
        clips: collectAudioClips({ tracks, assets: doc.assets }), durationSeconds: plan.durationSeconds, sinks, signal,
      });
      if (audioMix) {
        audioSource = new AudioBufferSource({ codec: audioCodec, bitrate: QUALITY_HIGH });
        output.addAudioTrack(audioSource);
        hasAudio = true;
      }
    }
    await output.start();
    throwIfCanceled();

    // Audio is rendered and encoded one chunk at a time, just ahead of the video frames, so neither raw PCM nor
    // the muxer's interleave queue grows with project length.
    let audioSeconds = 0;
    const pumpAudio = async (untilSeconds: number): Promise<void> => {
      while (audioMix && audioSource && audioSeconds < untilSeconds) {
        const next = await audioMix.chunks.next();
        if (next.done) {
          audioSource.close();
          audioMix = null;
          return;
        }
        await audioSource.add(next.value);
        audioSeconds += next.value.duration;
      }
    };

    const compositor = new Compositor(canvas);
    const sources = new CachedFrameSources(videoFrames, images);
    const loopStart = now();
    for (let i = 0; i < plan.frameCount; i++) {
      throwIfCanceled();
      const time = frameStartTime(i, doc.settings.fps);
      const t0 = now();
      const framePlan = planFrame(i);
      if (framePlan.missingMedia.length > 0) throw new MissingMediaError(framePlan.missingMedia);
      const t1 = now();
      await sources.prepare(framePlan);
      const t2 = now();
      compositor.drawPlan(framePlan, sources);
      if (timings?.syncGpu) canvas.getContext("2d")?.getImageData(0, 0, 1, 1);
      const t3 = now();
      await pumpAudio(time / TICKS_PER_SECOND + AUDIO_LEAD_SECONDS);
      const t4 = now();
      const sample = new VideoSample(canvas, { timestamp: time / TICKS_PER_SECOND, duration: plan.frameDurationSeconds });
      const t5 = now();
      try {
        await videoSource.add(sample);
      } finally {
        sample.close();
      }
      if (timings) {
        timings.captureMs += t5 - t4;
        timings.planMs += t1 - t0; timings.decodeMs += t2 - t1; timings.composeMs += t3 - t2;
        timings.audioMs += t4 - t3; timings.encodeMs += now() - t5; timings.frames++; timings.totalMs = now() - loopStart;
      }
      report("video", 0.05 + 0.93 * ((i + 1) / plan.frameCount));
    }

    await pumpAudio(Number.POSITIVE_INFINITY);
    report("finalizing", 0.98);
    await output.finalize();
    const blob = await exportTarget.result();
    report("finalizing", 1);
    return {
      blob, mimeType, extension: options.format,
      width: plan.width, height: plan.height, frameCount: plan.frameCount, durationSeconds: plan.durationSeconds,
      hasAudio, videoCodec, audioCodec: hasAudio ? audioCodec : null,
    };
  } catch (error) {
    await audioMix?.chunks.return(undefined).catch(() => undefined);
    await output.cancel().catch(() => undefined);
    await exportTarget.discard();
    throw signal?.aborted ? new ExportCanceledError() : error;
  } finally {
    await Promise.all([sinks.dispose(), videoFrames.dispose(), images.dispose()]);
  }
}
