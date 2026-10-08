import type { MotionLevel, SceneCut, ShotAnalysis, TimeRange } from "./types";

export const SIGNATURE_GRID_COLUMNS = 16;
export const SIGNATURE_GRID_ROWS = 9;
export const HISTOGRAM_BINS = 8;
export const PALETTE_LEVELS = 4;
export const PALETTE_BINS = PALETTE_LEVELS ** 3;
export const PALETTE_STRIDE = 4;

export const LUMA_DISTANCE_GAIN = 3;
export const CUT_MIN_SCORE = 0.3;
export const CUT_LOCAL_SIGMA = 4;
export const CUT_LOCAL_RADIUS_SAMPLES = 8;
export const CUT_MIN_LOCAL_SPREAD = 0.02;
const MAD_TO_SIGMA = 1.4826;
export const CUT_MIN_SHOT_SECONDS = 0.5;

export const MOTION_LOW_BELOW = 0.01;
export const MOTION_HIGH_FROM = 0.04;

export const PALETTE_COUNT = 3;
export const PALETTE_MIN_DISTINCT_RGB_DISTANCE = 48;

const LUMA_R = 0.2126;
const LUMA_G = 0.7152;
const LUMA_B = 0.0722;

export interface FrameSignature {
  /** Mean luminance (0..1) per cell of a 16x9 grid, row-major. */
  luma: Float32Array;
  /** 8-bin histogram per channel, R then G then B, each normalised to sum 1. */
  histogram: Float32Array;
  /** Per 4x4x4 RGB bin: [fraction of pixels, mean R, mean G, mean B] with channels 0..255. */
  palette: Float32Array;
}

export interface TimedSignature {
  time: number;
  signature: FrameSignature;
}

/** `rgba` is tightly packed w*h*4 pixel data (ImageData order). */
export function frameSignature(rgba: Uint8ClampedArray | Uint8Array, width: number, height: number): FrameSignature {
  const cols = SIGNATURE_GRID_COLUMNS;
  const rows = SIGNATURE_GRID_ROWS;
  const lumaSum = new Float64Array(cols * rows);
  const lumaCount = new Float64Array(cols * rows);
  const histogram = new Float32Array(HISTOGRAM_BINS * 3);
  const palette = new Float32Array(PALETTE_BINS * PALETTE_STRIDE);
  const binShift = 256 / HISTOGRAM_BINS;
  const paletteShift = 256 / PALETTE_LEVELS;
  const pixels = width * height;
  for (let y = 0; y < height; y++) {
    const row = Math.min(rows - 1, Math.floor((y * rows) / height));
    for (let x = 0; x < width; x++) {
      const p = (y * width + x) * 4;
      const r = rgba[p] as number;
      const g = rgba[p + 1] as number;
      const b = rgba[p + 2] as number;
      const cell = row * cols + Math.min(cols - 1, Math.floor((x * cols) / width));
      lumaSum[cell] = (lumaSum[cell] as number) + (LUMA_R * r + LUMA_G * g + LUMA_B * b) / 255;
      lumaCount[cell] = (lumaCount[cell] as number) + 1;
      histogram[Math.floor(r / binShift)] = (histogram[Math.floor(r / binShift)] as number) + 1;
      histogram[HISTOGRAM_BINS + Math.floor(g / binShift)] = (histogram[HISTOGRAM_BINS + Math.floor(g / binShift)] as number) + 1;
      histogram[2 * HISTOGRAM_BINS + Math.floor(b / binShift)] = (histogram[2 * HISTOGRAM_BINS + Math.floor(b / binShift)] as number) + 1;
      const bin = (Math.floor(r / paletteShift) * PALETTE_LEVELS + Math.floor(g / paletteShift)) * PALETTE_LEVELS + Math.floor(b / paletteShift);
      const o = bin * PALETTE_STRIDE;
      palette[o] = (palette[o] as number) + 1;
      palette[o + 1] = (palette[o + 1] as number) + r;
      palette[o + 2] = (palette[o + 2] as number) + g;
      palette[o + 3] = (palette[o + 3] as number) + b;
    }
  }
  const luma = new Float32Array(cols * rows);
  for (let i = 0; i < luma.length; i++) luma[i] = (lumaCount[i] as number) > 0 ? (lumaSum[i] as number) / (lumaCount[i] as number) : 0;
  if (pixels > 0) {
    for (let i = 0; i < histogram.length; i++) histogram[i] = (histogram[i] as number) / pixels;
    for (let bin = 0; bin < PALETTE_BINS; bin++) {
      const o = bin * PALETTE_STRIDE;
      const count = palette[o] as number;
      if (count > 0) {
        palette[o + 1] = (palette[o + 1] as number) / count;
        palette[o + 2] = (palette[o + 2] as number) / count;
        palette[o + 3] = (palette[o + 3] as number) / count;
        palette[o] = count / pixels;
      }
    }
  }
  return { luma, histogram, palette };
}

/** Mean absolute luminance-grid difference, 0..1. Also used as the per-frame motion measure. */
export function motionScore(a: FrameSignature, b: FrameSignature): number {
  let sum = 0;
  for (let i = 0; i < a.luma.length; i++) sum += Math.abs((a.luma[i] as number) - (b.luma[i] as number));
  return sum / a.luma.length;
}

/** Earth-mover distance between per-channel histograms, averaged over channels, 0..1 (black vs white = 1; one-bin shift = 1/7). */
function histogramDistance(a: FrameSignature, b: FrameSignature): number {
  let total = 0;
  for (let channel = 0; channel < 3; channel++) {
    let cumulativeA = 0;
    let cumulativeB = 0;
    for (let bin = 0; bin < HISTOGRAM_BINS - 1; bin++) {
      cumulativeA += a.histogram[channel * HISTOGRAM_BINS + bin] as number;
      cumulativeB += b.histogram[channel * HISTOGRAM_BINS + bin] as number;
      total += Math.abs(cumulativeA - cumulativeB);
    }
  }
  return total / ((HISTOGRAM_BINS - 1) * 3);
}

/** 0..1 difference between two frames: the larger of scaled luminance-grid change and histogram change. */
export function signatureDistance(a: FrameSignature, b: FrameSignature): number {
  return Math.max(Math.min(1, motionScore(a, b) * LUMA_DISTANCE_GAIN), histogramDistance(a, b));
}

export interface SceneCutOptions {
  minShotSeconds?: number;
  minScore?: number;
}

/**
 * Hard cuts from consecutive-sample distances. A step counts when it exceeds both a fixed floor
 * and the local median + 4 robust sigmas (MAD) of its neighbours, then the strongest step wins inside any
 * minimum-shot-length neighbourhood. Slow fades and pans produce small steps and are not reported.
 * `time` is the timestamp of the first sample after the change (coarse when sampling is sparse;
 * refine with `locateCut` on denser samples).
 */
export function detectSceneCuts(samples: ReadonlyArray<TimedSignature>, options: SceneCutOptions = {}): SceneCut[] {
  const minShot = options.minShotSeconds ?? CUT_MIN_SHOT_SECONDS;
  const floor = options.minScore ?? CUT_MIN_SCORE;
  const steps: number[] = [0];
  for (let i = 1; i < samples.length; i++) {
    steps.push(signatureDistance((samples[i - 1] as TimedSignature).signature, (samples[i] as TimedSignature).signature));
  }
  const candidates: SceneCut[] = [];
  for (let i = 1; i < steps.length; i++) {
    const score = steps[i] as number;
    if (score < floor) continue;
    const neighbours: number[] = [];
    for (let j = Math.max(1, i - CUT_LOCAL_RADIUS_SAMPLES); j <= Math.min(steps.length - 1, i + CUT_LOCAL_RADIUS_SAMPLES); j++) {
      if (j !== i) neighbours.push(steps[j] as number);
    }
    const centre = median(neighbours);
    const spread = MAD_TO_SIGMA * median(neighbours.map((n) => Math.abs(n - centre)));
    if (score < centre + CUT_LOCAL_SIGMA * Math.max(spread, CUT_MIN_LOCAL_SPREAD)) continue;
    candidates.push({ time: (samples[i] as TimedSignature).time, score });
  }
  const accepted: SceneCut[] = [];
  for (const candidate of [...candidates].sort((a, b) => b.score - a.score)) {
    if (accepted.every((c) => Math.abs(c.time - candidate.time) >= minShot)) accepted.push(candidate);
  }
  return accepted.sort((a, b) => a.time - b.time);
}

/** Within densely sampled frames around a known cut, the time of the largest step. */
export function locateCut(samples: ReadonlyArray<TimedSignature>): SceneCut | null {
  let best: SceneCut | null = null;
  for (let i = 1; i < samples.length; i++) {
    const score = signatureDistance((samples[i - 1] as TimedSignature).signature, (samples[i] as TimedSignature).signature);
    if (!best || score > best.score) best = { time: (samples[i] as TimedSignature).time, score };
  }
  return best;
}

export function motionLevel(score: number): MotionLevel {
  if (score < MOTION_LOW_BELOW) return "low";
  return score < MOTION_HIGH_FROM ? "med" : "high";
}

function median(values: ReadonlyArray<number>): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? (sorted[mid] as number) : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}

const hex = (value: number): string => Math.max(0, Math.min(255, Math.round(value))).toString(16).padStart(2, "0");

/** Most common colours across signatures; near-identical bins fold into the more common one. */
export function dominantColorsFromSignatures(signatures: ReadonlyArray<FrameSignature>, count: number = PALETTE_COUNT): string[] {
  const weight = new Float64Array(PALETTE_BINS);
  const sums = new Float64Array(PALETTE_BINS * 3);
  for (const { palette } of signatures) {
    for (let bin = 0; bin < PALETTE_BINS; bin++) {
      const o = bin * PALETTE_STRIDE;
      const fraction = palette[o] as number;
      if (fraction <= 0) continue;
      weight[bin] = (weight[bin] as number) + fraction;
      for (let c = 0; c < 3; c++) sums[bin * 3 + c] = (sums[bin * 3 + c] as number) + fraction * (palette[o + 1 + c] as number);
    }
  }
  const order = Array.from({ length: PALETTE_BINS }, (_, i) => i).filter((i) => (weight[i] as number) > 0).sort((a, b) => (weight[b] as number) - (weight[a] as number));
  const picked: Array<[number, number, number]> = [];
  for (const bin of order) {
    const w = weight[bin] as number;
    const color: [number, number, number] = [(sums[bin * 3] as number) / w, (sums[bin * 3 + 1] as number) / w, (sums[bin * 3 + 2] as number) / w];
    const tooClose = picked.some((p) => Math.hypot(p[0] - color[0], p[1] - color[1], p[2] - color[2]) < PALETTE_MIN_DISTINCT_RGB_DISTANCE);
    if (tooClose) continue;
    picked.push(color);
    if (picked.length === count) break;
  }
  return picked.map(([r, g, b]) => `#${hex(r)}${hex(g)}${hex(b)}`);
}

export function dominantColors(rgba: Uint8ClampedArray | Uint8Array, width: number, height: number, count: number = PALETTE_COUNT): string[] {
  return dominantColorsFromSignatures([frameSignature(rgba, width, height)], count);
}

export function buildShotRanges(cuts: ReadonlyArray<{ time: number }>, durationSeconds: number): TimeRange[] {
  const bounds = [0, ...cuts.map((c) => c.time).filter((t) => t > 0 && t < durationSeconds), durationSeconds];
  const shots: TimeRange[] = [];
  for (let i = 0; i < bounds.length - 1; i++) {
    const start = bounds[i] as number;
    const end = bounds[i + 1] as number;
    if (end > start) shots.push({ start, end });
  }
  return shots;
}

/** Shot list with per-shot motion level and palette, from the sampled signatures. */
export function analyzeShots(input: { samples: ReadonlyArray<TimedSignature>; cuts: ReadonlyArray<{ time: number }>; durationSeconds: number }): ShotAnalysis[] {
  return buildShotRanges(input.cuts, input.durationSeconds).map((range) => {
    const inside = input.samples.filter((s) => s.time >= range.start - 1e-9 && s.time < range.end - 1e-9);
    let motion = 0;
    for (let i = 1; i < inside.length; i++) motion += motionScore((inside[i - 1] as TimedSignature).signature, (inside[i] as TimedSignature).signature);
    const motionScoreValue = inside.length > 1 ? motion / (inside.length - 1) : 0;
    return {
      ...range,
      motion: motionLevel(motionScoreValue),
      motionScore: motionScoreValue,
      dominantColors: dominantColorsFromSignatures(inside.map((s) => s.signature)),
    };
  });
}
