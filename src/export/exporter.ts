import {
  AudioBufferSource, BufferTarget, CanvasSource, Mp4OutputFormat, Output, QUALITY_HIGH, QUALITY_LOW, QUALITY_MEDIUM,
  QUALITY_VERY_HIGH, WebMOutputFormat, canEncodeAudio, getFirstEncodableVideoCodec, type AudioCodec, type Quality,
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
import { CachedFrameSources, ImageCache } from "#/platform/frame-sources";
import { VideoFrameCache } from "#/platform/video-frames";
import { mixTimelineAudio } from "./audio-mix";
import { planExport, type ExportOptions } from "./plan";

export type ExportPhase = "preparing" | "audio" | "video" | "finalizing";

export interface ExportProgress {
  phase: ExportPhase;
  /** 0..1 across the whole export. */
  progress: number;
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
}): Promise<ExportResult> {
  const { doc, options, signal } = input;
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

  report("preparing", 0);
  const videoCodec = await getFirstEncodableVideoCodec(
    options.format === "mp4" ? ["avc", "vp9", "av1"] : ["vp9", "vp8", "av1"],
    { width: plan.width, height: plan.height, quality: QUALITIES[options.quality] },
  );
  if (!videoCodec) throw new Error("This browser cannot encode video at this size");
  const audioCodec = options.includeAudio ? await pickAudioCodec(options.format) : null;

  const output = new Output({
    format: options.format === "mp4" ? new Mp4OutputFormat() : new WebMOutputFormat(),
    target: new BufferTarget(),
  });
  const canvas = createCanvas(plan.width, plan.height);
  const videoSource = new CanvasSource(canvas, { codec: videoCodec, bitrate: QUALITIES[options.quality] });
  output.addVideoTrack(videoSource, { frameRate: frameRateToFloat(doc.settings.fps) });

  const sinks = new AudioSinkCache(input.getBlob);
  const videoFrames = new VideoFrameCache(input.getBlob);
  const images = new ImageCache(input.getBlob);
  let hasAudio = false;

  try {
    const tracks = currentScene(doc).tracks;
    let audioSource: AudioBufferSource | null = null;
    if (audioCodec) {
      report("audio", 0.02);
      const mixed = await mixTimelineAudio({
        clips: collectAudioClips({ tracks, assets: doc.assets }), durationSeconds: plan.durationSeconds, sinks, signal,
      });
      if (mixed) {
        audioSource = new AudioBufferSource({ codec: audioCodec, bitrate: QUALITY_HIGH });
        output.addAudioTrack(audioSource);
        hasAudio = true;
        await output.start();
        await audioSource.add(mixed);
        audioSource.close();
      }
    }
    if (!hasAudio) await output.start();
    throwIfCanceled();

    const compositor = new Compositor(canvas);
    const sources = new CachedFrameSources(videoFrames, images);
    const canvasSize = { width: plan.width, height: plan.height };
    for (let i = 0; i < plan.frameCount; i++) {
      throwIfCanceled();
      const time = frameStartTime(i, doc.settings.fps);
      const framePlan = buildFramePlan({ tracks, canvas: canvasSize, background: doc.settings.background, assets: doc.assets, time });
      if (framePlan.missingMedia.length > 0) throw new MissingMediaError(framePlan.missingMedia);
      await compositor.render(framePlan, sources);
      await videoSource.add(time / TICKS_PER_SECOND, plan.frameDurationSeconds);
      report("video", 0.05 + 0.93 * ((i + 1) / plan.frameCount));
    }

    report("finalizing", 0.98);
    await output.finalize();
    const buffer = (output.target as BufferTarget).buffer;
    if (!buffer) throw new Error("Export produced no data");
    const mimeType = options.format === "mp4" ? "video/mp4" : "video/webm";
    report("finalizing", 1);
    return {
      blob: new Blob([buffer], { type: mimeType }), mimeType, extension: options.format,
      width: plan.width, height: plan.height, frameCount: plan.frameCount, durationSeconds: plan.durationSeconds,
      hasAudio, videoCodec, audioCodec: hasAudio ? audioCodec : null,
    };
  } catch (error) {
    await output.cancel().catch(() => undefined);
    throw signal?.aborted ? new ExportCanceledError() : error;
  } finally {
    await Promise.all([sinks.dispose(), videoFrames.dispose(), images.dispose()]);
  }
}
