import { ALL_FORMATS, BlobSource, CanvasSink, Input } from "mediabunny";
import { frameRateFromFloat, mediaTimeFromSeconds } from "#/engine/time";
import type { MediaAssetInfo, MediaType } from "#/engine/model";
import { capabilityIssues, detectCapabilities } from "./capabilities";

export const THUMBNAIL_MAX_WIDTH = 480;
export const THUMBNAIL_MAX_HEIGHT = 270;
const FPS_PROBE_PACKETS = 100;

export class UnsupportedMediaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsupportedMediaError";
  }
}

const EXTENSIONS: Record<string, MediaType> = {
  mp4: "video", m4v: "video", mov: "video", webm: "video", mkv: "video", ogv: "video",
  mp3: "audio", wav: "audio", m4a: "audio", aac: "audio", ogg: "audio", oga: "audio", opus: "audio", flac: "audio",
  png: "image", jpg: "image", jpeg: "image", gif: "image", webp: "image", avif: "image", bmp: "image",
};

/** Classifies by MIME prefix first, then by extension for files browsers leave untyped. */
export function mediaTypeOf(file: { type: string; name: string }): MediaType | null {
  const prefix = file.type.split("/")[0];
  if (prefix === "video" || prefix === "audio" || prefix === "image") return prefix;
  const ext = file.name.toLowerCase().split(".").pop() ?? "";
  return EXTENSIONS[ext] ?? null;
}

export function fitWithin(width: number, height: number, maxW: number, maxH: number): { width: number; height: number } {
  const scale = Math.min(1, maxW / width, maxH / height);
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

async function canvasToJpegDataUrl(canvas: HTMLCanvasElement | OffscreenCanvas): Promise<string> {
  const blob = canvas instanceof OffscreenCanvas
    ? await canvas.convertToBlob({ type: "image/jpeg", quality: 0.8 })
    : await new Promise<Blob>((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Thumbnail encode failed"))), "image/jpeg", 0.8));
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error ?? new Error("Thumbnail read failed"));
    reader.readAsDataURL(blob);
  });
}

async function probeImage(file: File, id: string): Promise<MediaAssetInfo> {
  const bitmap = await createImageBitmap(file);
  try {
    const size = fitWithin(bitmap.width, bitmap.height, THUMBNAIL_MAX_WIDTH, THUMBNAIL_MAX_HEIGHT);
    const canvas = new OffscreenCanvas(size.width, size.height);
    canvas.getContext("2d")?.drawImage(bitmap, 0, 0, size.width, size.height);
    return {
      id, name: file.name, type: "image", size: file.size, lastModified: file.lastModified,
      width: bitmap.width, height: bitmap.height, thumbnail: await canvasToJpegDataUrl(canvas),
    };
  } finally {
    bitmap.close();
  }
}

/** Fails with a precise message when the browser has no WebCodecs decoder at all, before mediabunny reports a vague error. */
function requireVideoDecoding(): void {
  const missing = capabilityIssues(detectCapabilities()).find((issue) => issue.id === "videoDecoding");
  if (missing) throw new UnsupportedMediaError(missing.message);
}

async function probeVideo(file: File, id: string): Promise<MediaAssetInfo> {
  requireVideoDecoding();
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  try {
    const track = await input.getPrimaryVideoTrack();
    if (!track) throw new UnsupportedMediaError(`${file.name} has no video track`);
    if (!(await track.canDecode())) throw new UnsupportedMediaError(`${file.name} uses a codec this browser cannot decode`);
    const width = await track.getDisplayWidth();
    const height = await track.getDisplayHeight();
    const duration = await input.computeDuration();
    const metrics = await track.computeFrameRateMetrics({ targetPacketCount: FPS_PROBE_PACKETS });
    const hasAudio = (await input.getPrimaryAudioTrack()) !== null;
    const size = fitWithin(width, height, THUMBNAIL_MAX_WIDTH, THUMBNAIL_MAX_HEIGHT);
    let thumbnail: string | undefined;
    try {
      const sink = new CanvasSink(track, { width: size.width, height: size.height, fit: "fill" });
      const frame = await sink.getCanvas(Math.min(1, duration / 2));
      if (frame) thumbnail = await canvasToJpegDataUrl(frame.canvas);
    } catch (error) {
      console.warn("Could not generate a video thumbnail", error);
    }
    return {
      id, name: file.name, type: "video", size: file.size, lastModified: file.lastModified, width, height,
      duration: mediaTimeFromSeconds(duration),
      fps: metrics.bestGuessFrameRate > 0 ? frameRateFromFloat(metrics.bestGuessFrameRate) : undefined,
      hasAudio, thumbnail,
    };
  } finally {
    input.dispose();
  }
}

async function probeAudio(file: File, id: string): Promise<MediaAssetInfo> {
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  try {
    const track = await input.getPrimaryAudioTrack();
    if (!track) throw new UnsupportedMediaError(`${file.name} has no audio track`);
    if (!(await track.canDecode())) throw new UnsupportedMediaError(`${file.name} uses a codec this browser cannot decode`);
    const duration = await input.computeDuration();
    return { id, name: file.name, type: "audio", size: file.size, lastModified: file.lastModified, duration: mediaTimeFromSeconds(duration), hasAudio: true };
  } finally {
    input.dispose();
  }
}

/** Reads everything the editor needs from a file: type, size, duration, fps, audio presence and a thumbnail. */
export async function probeMedia(file: File, id: string): Promise<MediaAssetInfo> {
  const type = mediaTypeOf(file);
  if (!type) throw new UnsupportedMediaError(`${file.name} is not a supported video, audio or image file`);
  try {
    switch (type) {
      case "image": return await probeImage(file, id);
      case "video": return await probeVideo(file, id);
      case "audio": return await probeAudio(file, id);
    }
  } catch (error) {
    if (error instanceof UnsupportedMediaError) throw error;
    throw new UnsupportedMediaError(`Could not read ${file.name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}
