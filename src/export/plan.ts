import { TICKS_PER_SECOND, frameDuration, type FrameRate } from "#/engine/time";
import type { CanvasSize } from "#/engine/model";

export interface ExportOptions {
  format: "mp4" | "webm";
  quality: "low" | "medium" | "high" | "very_high";
  includeAudio: boolean;
}

export const DEFAULT_EXPORT_OPTIONS: ExportOptions = { format: "mp4", quality: "high", includeAudio: true };

export interface ExportPlan {
  /** Even dimensions: most video encoders reject odd sizes. */
  width: number;
  height: number;
  frameCount: number;
  frameDurationSeconds: number;
  durationSeconds: number;
}

const toEven = (n: number): number => Math.max(2, Math.round(n / 2) * 2);

/** Number of frames and encode size, derived only from project state. */
export function planExport(input: { durationTicks: number; fps: FrameRate; canvas: CanvasSize }): ExportPlan {
  const frame = frameDuration(input.fps);
  const frameCount = input.durationTicks <= 0 ? 0 : Math.max(1, Math.ceil(input.durationTicks / frame - 1e-9));
  return {
    width: toEven(input.canvas.width),
    height: toEven(input.canvas.height),
    frameCount,
    frameDurationSeconds: frame / TICKS_PER_SECOND,
    durationSeconds: input.durationTicks / TICKS_PER_SECOND,
  };
}

const RESERVED_DEVICE_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

export function exportFileName(projectName: string, extension: string): string {
  const cleaned = [...projectName].filter((ch) => ch.charCodeAt(0) > 31 && ch.charCodeAt(0) !== 127).join("")
    .replace(/[\\/:*?"<>|]+/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[. ]+$/, "");
  const safe = cleaned === "" || RESERVED_DEVICE_NAMES.test(cleaned) ? "export" : cleaned;
  return `${safe}.${extension}`;
}
