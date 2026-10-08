import type { LevelCurve, LoudnessStats, SilenceRange, TimeRange } from "./types";

export const RMS_WINDOW_SECONDS = 0.02;
export const SILENCE_FLOOR_DB = -100;
export const DEFAULT_SILENCE_THRESHOLD_DB = -45;
export const DEFAULT_SILENCE_MIN_SECONDS = 0.3;
export const INTEGRATED_BLOCK_SECONDS = 0.4;
export const INTEGRATED_ABSOLUTE_GATE_DB = -70;
export const INTEGRATED_RELATIVE_GATE_DB = -10;
export const LEVEL_CURVE_WINDOW_SECONDS = 0.25;
export const SPEECH_NOISE_FLOOR_PERCENTILE = 0.1;
export const SPEECH_MARGIN_ABOVE_FLOOR_DB = 12;
export const SPEECH_MIN_LEVEL_DB = -50;
export const SPEECH_MERGE_GAP_SECONDS = 0.25;
export const SPEECH_MIN_RANGE_SECONDS = 0.3;
export const SPEECH_MIN_MODULATION_DB = 3;

/** Per-window mean-square and peak of a mono signal. */
export interface RmsWindows {
  windowSeconds: number;
  /** Mean of squared samples per window (linear power). */
  meanSquare: Float32Array;
  /** Largest absolute sample per window. */
  peak: Float32Array;
}

export const powerToDb = (power: number): number => (power > 0 ? Math.max(SILENCE_FLOOR_DB, 10 * Math.log10(power)) : SILENCE_FLOOR_DB);
export const amplitudeToDb = (amplitude: number): number => (amplitude > 0 ? Math.max(SILENCE_FLOOR_DB, 20 * Math.log10(amplitude)) : SILENCE_FLOOR_DB);

/** Streaming accumulator: feed decoded chunks in order; never holds the whole file. */
export class RmsAccumulator {
  private sumSquares: number[] = [];
  private counts: number[] = [];
  private peaks: number[] = [];

  constructor(readonly windowSeconds: number = RMS_WINDOW_SECONDS) {}

  /** `channels` are mixed to mono by averaging; `startSeconds` is the chunk's source timestamp. */
  push(input: { channels: ReadonlyArray<Float32Array>; sampleRate: number; startSeconds: number }): void {
    const { channels, sampleRate } = input;
    const length = channels[0]?.length ?? 0;
    const channelCount = channels.length;
    if (channelCount === 0) return;
    const firstSample = Math.round(input.startSeconds * sampleRate);
    for (let i = 0; i < length; i++) {
      let mono = 0;
      for (const channel of channels) mono += channel[i] ?? 0;
      mono /= channelCount;
      const slot = Math.floor((firstSample + i) / sampleRate / this.windowSeconds);
      if (slot < 0) continue;
      while (this.sumSquares.length <= slot) {
        this.sumSquares.push(0);
        this.counts.push(0);
        this.peaks.push(0);
      }
      this.sumSquares[slot] = (this.sumSquares[slot] as number) + mono * mono;
      this.counts[slot] = (this.counts[slot] as number) + 1;
      const magnitude = Math.abs(mono);
      if (magnitude > (this.peaks[slot] as number)) this.peaks[slot] = magnitude;
    }
  }

  finish(): RmsWindows {
    const n = this.sumSquares.length;
    const meanSquare = new Float32Array(n);
    const peak = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const count = this.counts[i] as number;
      meanSquare[i] = count > 0 ? (this.sumSquares[i] as number) / count : 0;
      peak[i] = this.peaks[i] as number;
    }
    return { windowSeconds: this.windowSeconds, meanSquare, peak };
  }
}

export function computeRmsWindows(input: { samples: Float32Array; sampleRate: number; windowSeconds?: number }): RmsWindows {
  const accumulator = new RmsAccumulator(input.windowSeconds);
  accumulator.push({ channels: [input.samples], sampleRate: input.sampleRate, startSeconds: 0 });
  return accumulator.finish();
}

export function windowLevelsDb(windows: RmsWindows): Float32Array {
  const out = new Float32Array(windows.meanSquare.length);
  for (let i = 0; i < out.length; i++) out[i] = powerToDb(windows.meanSquare[i] as number);
  return out;
}

export type SilenceInput =
  | { windows: RmsWindows; samples?: undefined; sampleRate?: undefined; thresholdDb?: number; minDuration?: number }
  | { samples: Float32Array; sampleRate: number; windows?: undefined; thresholdDb?: number; minDuration?: number };

/**
 * Ranges where the 20 ms RMS stays below `thresholdDb` for at least `minDuration` seconds.
 * Boundaries are window-aligned, so edges can be off by up to one window (20 ms), always on the conservative side.
 */
export function detectSilence(input: SilenceInput): SilenceRange[] {
  const windows = input.windows ?? computeRmsWindows({ samples: input.samples, sampleRate: input.sampleRate });
  const thresholdDb = input.thresholdDb ?? DEFAULT_SILENCE_THRESHOLD_DB;
  const minDuration = input.minDuration ?? DEFAULT_SILENCE_MIN_SECONDS;
  const levels = windowLevelsDb(windows);
  const out: SilenceRange[] = [];
  let runStart = -1;
  let runSum = 0;
  const close = (endIndex: number): void => {
    if (runStart < 0) return;
    const start = runStart * windows.windowSeconds;
    const end = endIndex * windows.windowSeconds;
    if (end - start >= minDuration - 1e-9) out.push({ start, end, meanDb: runSum / (endIndex - runStart) });
    runStart = -1;
    runSum = 0;
  };
  for (let i = 0; i < levels.length; i++) {
    const level = levels[i] as number;
    if (level < thresholdDb) {
      if (runStart < 0) runStart = i;
      runSum += level;
    } else {
      close(i);
    }
  }
  close(levels.length);
  return out;
}

export function loudnessStats(windows: RmsWindows): LoudnessStats {
  const n = windows.meanSquare.length;
  let total = 0;
  let peak = 0;
  for (let i = 0; i < n; i++) {
    total += windows.meanSquare[i] as number;
    peak = Math.max(peak, windows.peak[i] as number);
  }
  const rmsDb = n > 0 ? powerToDb(total / n) : SILENCE_FLOOR_DB;

  const blockWindows = Math.max(1, Math.round(INTEGRATED_BLOCK_SECONDS / windows.windowSeconds));
  const hop = Math.max(1, Math.floor(blockWindows / 4));
  const blocks: number[] = [];
  for (let i = 0; i + blockWindows <= n; i += hop) {
    let sum = 0;
    for (let j = i; j < i + blockWindows; j++) sum += windows.meanSquare[j] as number;
    blocks.push(sum / blockWindows);
  }
  const absolute = blocks.filter((b) => powerToDb(b) > INTEGRATED_ABSOLUTE_GATE_DB);
  let integratedApproxDb = SILENCE_FLOOR_DB;
  if (absolute.length > 0) {
    const ungatedDb = powerToDb(absolute.reduce((a, b) => a + b, 0) / absolute.length);
    const relative = absolute.filter((b) => powerToDb(b) > ungatedDb + INTEGRATED_RELATIVE_GATE_DB);
    integratedApproxDb = powerToDb(relative.reduce((a, b) => a + b, 0) / Math.max(1, relative.length));
  }
  return { peakDb: amplitudeToDb(peak), rmsDb, integratedApproxDb };
}

/** Coarse level curve (mean-square averaged per window) so timeline loudness needs no re-decode. */
export function levelCurve(windows: RmsWindows, curveWindowSeconds: number = LEVEL_CURVE_WINDOW_SECONDS): LevelCurve {
  const per = Math.max(1, Math.round(curveWindowSeconds / windows.windowSeconds));
  const db: number[] = [];
  for (let i = 0; i < windows.meanSquare.length; i += per) {
    let sum = 0;
    let count = 0;
    for (let j = i; j < Math.min(windows.meanSquare.length, i + per); j++) {
      sum += windows.meanSquare[j] as number;
      count++;
    }
    db.push(powerToDb(sum / count));
  }
  return { windowSeconds: per * windows.windowSeconds, db };
}

function percentile(sorted: ArrayLike<number>, p: number): number {
  if (sorted.length === 0) return SILENCE_FLOOR_DB;
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] as number;
}

/**
 * HEURISTIC: stretches that are clearly above the noise floor and whose level fluctuates like syllables.
 * Steady tones and steady noise are rejected by the modulation test. This is not speech recognition.
 */
export function detectSpeechLikeRanges(windows: RmsWindows): TimeRange[] {
  const levels = windowLevelsDb(windows);
  if (levels.length === 0) return [];
  const sorted = Float32Array.from(levels).sort();
  const floor = percentile(sorted, SPEECH_NOISE_FLOOR_PERCENTILE);
  const activeAbove = Math.max(SPEECH_MIN_LEVEL_DB, floor + SPEECH_MARGIN_ABOVE_FLOOR_DB);
  const mergeWindows = Math.round(SPEECH_MERGE_GAP_SECONDS / windows.windowSeconds);

  const runs: Array<[number, number]> = [];
  let start = -1;
  let lastActive = -1;
  for (let i = 0; i < levels.length; i++) {
    if ((levels[i] as number) >= activeAbove) {
      if (start < 0) start = i;
      else if (i - lastActive > mergeWindows) {
        runs.push([start, lastActive + 1]);
        start = i;
      }
      lastActive = i;
    }
  }
  if (start >= 0) runs.push([start, lastActive + 1]);

  const out: TimeRange[] = [];
  for (const [from, to] of runs) {
    if ((to - from) * windows.windowSeconds < SPEECH_MIN_RANGE_SECONDS) continue;
    let mean = 0;
    for (let i = from; i < to; i++) mean += levels[i] as number;
    mean /= to - from;
    let variance = 0;
    for (let i = from; i < to; i++) variance += ((levels[i] as number) - mean) ** 2;
    if (Math.sqrt(variance / (to - from)) < SPEECH_MIN_MODULATION_DB) continue;
    out.push({ start: from * windows.windowSeconds, end: to * windows.windowSeconds });
  }
  return out;
}
