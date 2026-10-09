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

/**
 * ITU-R BS.1770 K-weighting: a high-shelf pre-filter (+4 dB above ~1.68 kHz) cascaded with an RLB high-pass
 * (~38 Hz), each a biquad designed with the standard cookbook equations
 * (https://www.w3.org/papers/Audio-EQ-Cookbook.txt) from the BS.1770 Annex 1 f0/Q/gain values, so the design is
 * correct at any sample rate rather than only the 48 kHz coefficients the standard tabulates.
 */
const K_WEIGHT_PRE_FILTER_HZ = 1681.9744509555612;
const K_WEIGHT_PRE_FILTER_GAIN_DB = 3.99984385397;
const K_WEIGHT_PRE_FILTER_Q = 0.7071752369554193;
const K_WEIGHT_RLB_HZ = 38.13547087613982;
const K_WEIGHT_RLB_Q = 0.5003270373253953;
/** BS.1770 integrated-loudness normalisation constant: LUFS = offset + 10*log10(gated mean K-weighted power). */
export const BS1770_LUFS_OFFSET_DB = -0.691;

interface BiquadCoeffs { b0: number; b1: number; b2: number; a1: number; a2: number }

function highShelfCoeffs(sampleRate: number, f0: number, gainDb: number, q: number): BiquadCoeffs {
  const a = 10 ** (gainDb / 40);
  const w0 = (2 * Math.PI * f0) / sampleRate;
  const cosW0 = Math.cos(w0);
  const alpha = Math.sin(w0) / (2 * q);
  const sqrtA = Math.sqrt(a);
  const a0 = a + 1 - (a - 1) * cosW0 + 2 * sqrtA * alpha;
  return {
    b0: (a * (a + 1 + (a - 1) * cosW0 + 2 * sqrtA * alpha)) / a0,
    b1: (-2 * a * (a - 1 + (a + 1) * cosW0)) / a0,
    b2: (a * (a + 1 + (a - 1) * cosW0 - 2 * sqrtA * alpha)) / a0,
    a1: (2 * (a - 1 - (a + 1) * cosW0)) / a0,
    a2: (a + 1 - (a - 1) * cosW0 - 2 * sqrtA * alpha) / a0,
  };
}

function highPassCoeffs(sampleRate: number, f0: number, q: number): BiquadCoeffs {
  const w0 = (2 * Math.PI * f0) / sampleRate;
  const cosW0 = Math.cos(w0);
  const alpha = Math.sin(w0) / (2 * q);
  const a0 = 1 + alpha;
  return {
    b0: (1 + cosW0) / 2 / a0,
    b1: (-(1 + cosW0)) / a0,
    b2: (1 + cosW0) / 2 / a0,
    a1: (-2 * cosW0) / a0,
    a2: (1 - alpha) / a0,
  };
}

/** Direct-form-I biquad with its own state; `process` must be called once per sample, in stream order. */
class Biquad {
  private x1 = 0;
  private x2 = 0;
  private y1 = 0;
  private y2 = 0;
  constructor(private readonly c: BiquadCoeffs) {}
  process(x: number): number {
    const y = this.c.b0 * x + this.c.b1 * this.x1 + this.c.b2 * this.x2 - this.c.a1 * this.y1 - this.c.a2 * this.y2;
    this.x2 = this.x1;
    this.x1 = x;
    this.y2 = this.y1;
    this.y1 = y;
    return y;
  }
}

/** Cascaded high-shelf + RLB high-pass K-weighting filter, stateful across an entire stream at one sample rate. */
class KWeightingFilter {
  private readonly shelf: Biquad;
  private readonly highPass: Biquad;
  constructor(sampleRate: number) {
    this.shelf = new Biquad(highShelfCoeffs(sampleRate, K_WEIGHT_PRE_FILTER_HZ, K_WEIGHT_PRE_FILTER_GAIN_DB, K_WEIGHT_PRE_FILTER_Q));
    this.highPass = new Biquad(highPassCoeffs(sampleRate, K_WEIGHT_RLB_HZ, K_WEIGHT_RLB_Q));
  }
  process(x: number): number {
    return this.highPass.process(this.shelf.process(x));
  }
}

/** `power` is a K-weighted mean-square value; applies the fixed BS.1770 LUFS normalisation constant. */
export const powerToLufs = (power: number): number =>
  power > 0 ? Math.max(SILENCE_FLOOR_DB, BS1770_LUFS_OFFSET_DB + 10 * Math.log10(power)) : SILENCE_FLOOR_DB;

/**
 * Streaming accumulator for the BS.1770 integrated-loudness figure. Each channel runs through its own K-weighting
 * filter (state persists across `push` calls, so chunking adds no boundary artifacts). BS.1770 sums the channels'
 * K-weighted mean-square POWER (unit weights), so the filtered channels are folded into one signal whose
 * instantaneous value is sqrt(sum of squares): its mean square equals the sum of the per-channel mean squares.
 * An inner `RmsAccumulator` then windows it so block-gating in `loudnessStats` matches the unweighted path.
 */
export class IntegratedLoudnessAccumulator {
  private readonly inner: RmsAccumulator;
  private filters: KWeightingFilter[] = [];

  constructor(readonly windowSeconds: number = RMS_WINDOW_SECONDS) {
    this.inner = new RmsAccumulator(windowSeconds);
  }

  push(input: { channels: ReadonlyArray<Float32Array>; sampleRate: number; startSeconds: number }): void {
    const { channels, sampleRate, startSeconds } = input;
    const length = channels[0]?.length ?? 0;
    if (channels.length === 0) return;
    while (this.filters.length < channels.length) this.filters.push(new KWeightingFilter(sampleRate));
    const power = new Float32Array(length);
    channels.forEach((channel, c) => {
      const filter = this.filters[c] as KWeightingFilter;
      for (let i = 0; i < length; i++) {
        const y = filter.process(channel[i] ?? 0);
        power[i] = (power[i] as number) + y * y;
      }
    });
    for (let i = 0; i < length; i++) power[i] = Math.sqrt(power[i] as number);
    this.inner.push({ channels: [power], sampleRate, startSeconds });
  }

  finish(): RmsWindows {
    return this.inner.finish();
  }
}

export function computeKWeightedWindows(input: { samples: Float32Array; sampleRate: number; windowSeconds?: number }): RmsWindows {
  const accumulator = new IntegratedLoudnessAccumulator(input.windowSeconds);
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

/** BS.1770 400 ms block-gating (absolute gate, then relative gate 10 dB below the ungated mean), generic over the dB/LU scale `toDb` maps power onto. */
function gatedBlockMeanDb(windows: RmsWindows, toDb: (power: number) => number): number {
  const n = windows.meanSquare.length;
  const blockWindows = Math.max(1, Math.round(INTEGRATED_BLOCK_SECONDS / windows.windowSeconds));
  const hop = Math.max(1, Math.floor(blockWindows / 4));
  const blocks: number[] = [];
  for (let i = 0; i + blockWindows <= n; i += hop) {
    let sum = 0;
    for (let j = i; j < i + blockWindows; j++) sum += windows.meanSquare[j] as number;
    blocks.push(sum / blockWindows);
  }
  const absolute = blocks.filter((b) => toDb(b) > INTEGRATED_ABSOLUTE_GATE_DB);
  if (absolute.length === 0) return SILENCE_FLOOR_DB;
  const ungatedDb = toDb(absolute.reduce((a, b) => a + b, 0) / absolute.length);
  const relative = absolute.filter((b) => toDb(b) > ungatedDb + INTEGRATED_RELATIVE_GATE_DB);
  return toDb(relative.reduce((a, b) => a + b, 0) / Math.max(1, relative.length));
}

/**
 * `kWeightedWindows` (see `IntegratedLoudnessAccumulator`/`computeKWeightedWindows`) feeds a real BS.1770
 * `integratedLufs`. Omit it to get the legacy unweighted `integratedApproxDb` only, unchanged.
 */
export function loudnessStats(windows: RmsWindows, kWeightedWindows?: RmsWindows): LoudnessStats {
  const n = windows.meanSquare.length;
  let total = 0;
  let peak = 0;
  for (let i = 0; i < n; i++) {
    total += windows.meanSquare[i] as number;
    peak = Math.max(peak, windows.peak[i] as number);
  }
  const rmsDb = n > 0 ? powerToDb(total / n) : SILENCE_FLOOR_DB;
  const integratedApproxDb = gatedBlockMeanDb(windows, powerToDb);
  const integratedLufs = kWeightedWindows ? gatedBlockMeanDb(kWeightedWindows, powerToLufs) : undefined;
  return { peakDb: amplitudeToDb(peak), rmsDb, integratedApproxDb, ...(integratedLufs !== undefined ? { integratedLufs } : {}) };
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
