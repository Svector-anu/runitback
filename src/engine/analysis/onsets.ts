import { windowLevelsDb, type RmsWindows } from "./audio";
import type { Onset, TempoEstimate } from "./types";

export const ONSET_MIN_RISE_DB = 6;
export const ONSET_FULL_STRENGTH_DB = 30;
export const ONSET_MIN_GAP_SECONDS = 0.1;
export const ONSET_LOCAL_WINDOW_SECONDS = 1;
export const ONSET_LOCAL_SIGMA = 2;
export const ONSET_FLOOR_DB = -80;

export const TEMPO_MIN_BPM = 60;
export const TEMPO_MAX_BPM = 200;
export const TEMPO_PRIOR_CENTER_BPM = 120;
export const TEMPO_PRIOR_WIDTH_OCTAVES = 1;
export const TEMPO_ENVELOPE_STEP_SECONDS = 0.01;
export const TEMPO_SMOOTHING_RADIUS_BINS = 2;
export const TEMPO_DOUBLE_TIME_RATIO = 0.8;
export const TEMPO_MIN_ONSETS = 4;
export const TEMPO_MIN_CONFIDENCE = 0.2;
export const TEMPO_BEAT_MATCH_TOLERANCE = 0.2;

/**
 * Energy-flux onsets: half-wave rectified dB rise between consecutive RMS windows,
 * picked where the rise is a local maximum and stands out from the surrounding flux.
 * Time is the start of the window in which the rise happens (resolution = window length).
 */
export function detectOnsets(windows: RmsWindows): Onset[] {
  const levels = windowLevelsDb(windows);
  const n = levels.length;
  const flux = new Float32Array(n);
  for (let i = 1; i < n; i++) {
    const previous = Math.max(ONSET_FLOOR_DB, levels[i - 1] as number);
    const current = Math.max(ONSET_FLOOR_DB, levels[i] as number);
    flux[i] = Math.max(0, current - previous);
  }
  const radius = Math.max(1, Math.round(ONSET_LOCAL_WINDOW_SECONDS / windows.windowSeconds / 2));
  const gap = Math.max(1, Math.round(ONSET_MIN_GAP_SECONDS / windows.windowSeconds));
  const candidates: Onset[] = [];
  for (let i = 1; i < n; i++) {
    const value = flux[i] as number;
    if (value < ONSET_MIN_RISE_DB) continue;
    let sum = 0;
    let sumSquares = 0;
    let count = 0;
    let isMax = true;
    for (let j = Math.max(1, i - radius); j <= Math.min(n - 1, i + radius); j++) {
      const f = flux[j] as number;
      sum += f;
      sumSquares += f * f;
      count++;
      if (j !== i && Math.abs(j - i) <= gap && (f > value || (f === value && j < i))) isMax = false;
    }
    if (!isMax) continue;
    const mean = sum / count;
    const std = Math.sqrt(Math.max(0, sumSquares / count - mean * mean));
    if (value < mean + ONSET_LOCAL_SIGMA * std) continue;
    candidates.push({ time: i * windows.windowSeconds, strength: Math.min(1, value / ONSET_FULL_STRENGTH_DB) });
  }
  return candidates;
}

function autocorrelationAt(envelope: Float32Array, lag: number): number {
  let sum = 0;
  const n = envelope.length - lag;
  for (let i = 0; i < n; i++) sum += (envelope[i] as number) * (envelope[i + lag] as number);
  return n > 0 ? sum / n : 0;
}

/** Least-squares period over onsets that sit on the beat grid implied by `period`. */
function refinePeriod(onsets: ReadonlyArray<Onset>, period: number): number {
  const times = onsets.map((o) => o.time).sort((a, b) => a - b);
  const first = times[0];
  if (first === undefined) return period;
  const points: Array<[number, number]> = [];
  for (const t of times) {
    const index = Math.round((t - first) / period);
    if (Math.abs(t - first - index * period) <= TEMPO_BEAT_MATCH_TOLERANCE * period) points.push([index, t]);
  }
  if (points.length < 3) return period;
  const meanX = points.reduce((a, p) => a + p[0], 0) / points.length;
  const meanY = points.reduce((a, p) => a + p[1], 0) / points.length;
  let num = 0;
  let den = 0;
  for (const [x, y] of points) {
    num += (x - meanX) * (y - meanY);
    den += (x - meanX) ** 2;
  }
  return den > 0 ? num / den : period;
}

/**
 * Tempo from the autocorrelation of the onset-strength envelope (10 ms grid), searched over
 * 60-200 BPM with a log-normal prior around 120 BPM to settle half/double-time ambiguity,
 * then refined by regressing onset times on beat index.
 */
export function estimateTempo(onsets: ReadonlyArray<Onset>): TempoEstimate | null {
  if (onsets.length < TEMPO_MIN_ONSETS) return null;
  const last = onsets.reduce((m, o) => Math.max(m, o.time), 0);
  const length = Math.ceil(last / TEMPO_ENVELOPE_STEP_SECONDS) + 3;
  const envelope = new Float32Array(length);
  for (const onset of onsets) {
    const bin = Math.round(onset.time / TEMPO_ENVELOPE_STEP_SECONDS);
    envelope[bin] = (envelope[bin] as number) + onset.strength;
    envelope[bin - 1] = (envelope[bin - 1] as number) + onset.strength * 0.5;
    envelope[bin + 1] = (envelope[bin + 1] as number) + onset.strength * 0.5;
  }
  const mean = envelope.reduce((a, b) => a + b, 0) / envelope.length;
  for (let i = 0; i < envelope.length; i++) envelope[i] = (envelope[i] as number) - mean;
  const zeroLag = autocorrelationAt(envelope, 0);
  if (zeroLag <= 0) return null;

  const minLag = Math.floor(60 / TEMPO_MAX_BPM / TEMPO_ENVELOPE_STEP_SECONDS);
  const maxLag = Math.min(envelope.length - 2, Math.ceil(60 / TEMPO_MIN_BPM / TEMPO_ENVELOPE_STEP_SECONDS));
  const raw = new Map<number, number>();
  for (let lag = minLag - 1 - TEMPO_SMOOTHING_RADIUS_BINS; lag <= maxLag + 1 + TEMPO_SMOOTHING_RADIUS_BINS; lag++) raw.set(lag, autocorrelationAt(envelope, lag));
  const scores = new Map<number, number>();
  for (let lag = minLag - 1; lag <= maxLag + 1; lag++) {
    let sum = 0;
    let weights = 0;
    for (let d = -TEMPO_SMOOTHING_RADIUS_BINS; d <= TEMPO_SMOOTHING_RADIUS_BINS; d++) {
      const weight = TEMPO_SMOOTHING_RADIUS_BINS + 1 - Math.abs(d);
      sum += weight * (raw.get(lag + d) ?? 0);
      weights += weight;
    }
    scores.set(lag, sum / weights);
  }

  let bestLag = -1;
  let bestWeighted = -Infinity;
  for (let lag = minLag; lag <= maxLag; lag++) {
    const score = scores.get(lag) as number;
    if (score < (scores.get(lag - 1) as number) || score < (scores.get(lag + 1) as number)) continue;
    const bpm = 60 / (lag * TEMPO_ENVELOPE_STEP_SECONDS);
    const octaves = Math.log2(bpm / TEMPO_PRIOR_CENTER_BPM) / TEMPO_PRIOR_WIDTH_OCTAVES;
    const weighted = score * Math.exp(-0.5 * octaves * octaves);
    if (weighted > bestWeighted) {
      bestWeighted = weighted;
      bestLag = lag;
    }
  }
  if (bestLag < 0) return null;
  let doubleTimeLag = -1;
  for (let lag = Math.max(minLag, Math.round(bestLag / 2) - 2); lag <= Math.round(bestLag / 2) + 2; lag++) {
    if (lag < minLag || lag > maxLag) continue;
    if (doubleTimeLag < 0 || (scores.get(lag) as number) > (scores.get(doubleTimeLag) as number)) doubleTimeLag = lag;
  }
  if (doubleTimeLag > 0 && (scores.get(doubleTimeLag) as number) >= TEMPO_DOUBLE_TIME_RATIO * (scores.get(bestLag) as number)) bestLag = doubleTimeLag;
  const confidence = Math.max(0, Math.min(1, (scores.get(bestLag) as number) / zeroLag));
  if (confidence < TEMPO_MIN_CONFIDENCE) return null;

  const before = scores.get(bestLag - 1) as number;
  const here = scores.get(bestLag) as number;
  const after = scores.get(bestLag + 1) as number;
  const curvature = before - 2 * here + after;
  const offset = curvature < 0 ? (0.5 * (before - after)) / curvature : 0;
  const coarsePeriod = (bestLag + offset) * TEMPO_ENVELOPE_STEP_SECONDS;
  const bpm = 60 / refinePeriod(onsets, coarsePeriod);
  if (bpm < TEMPO_MIN_BPM - 1 || bpm > TEMPO_MAX_BPM + 1) return null;
  return { bpm, confidence };
}
