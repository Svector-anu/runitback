import { MEDIA_ANALYSIS_VERSION, type MediaAnalysis, type ShotAnalysis } from "#/engine/analysis";

export interface SyntheticOptions {
  assetId: string;
  /** Contiguous shot lengths in seconds. */
  lengths: number[];
  /** Adds tempo and onsets on the grid `phase + k * 60/bpm`. */
  bpm?: number;
  phase?: number;
  colors?: string[][];
  levelDb?: number[];
  silences?: Array<[number, number]>;
  hasAudio?: boolean;
}

export function syntheticAnalysis(options: SyntheticOptions): MediaAnalysis {
  let cursor = 0;
  const shots: ShotAnalysis[] = options.lengths.map((length, i) => {
    const shot: ShotAnalysis = { start: cursor, end: cursor + length, motion: "med", motionScore: 0.3, dominantColors: options.colors?.[i % options.colors.length] ?? [] };
    cursor += length;
    return shot;
  });
  const duration = cursor;
  const period = options.bpm ? 60 / options.bpm : 0;
  const onsets = [];
  if (options.bpm) for (let t = options.phase ?? 0; t < duration; t += period) onsets.push({ time: t, strength: 1 });
  return {
    assetId: options.assetId,
    version: MEDIA_ANALYSIS_VERSION,
    durationSeconds: duration,
    hasAudio: options.hasAudio ?? (options.bpm !== undefined || options.levelDb !== undefined),
    hasVideo: true,
    silences: (options.silences ?? []).map(([start, end]) => ({ start, end, meanDb: -70 })),
    loudness: null,
    speechLikeRanges: [],
    onsets,
    ...(options.bpm ? { tempoBpm: options.bpm, tempoConfidence: 0.9 } : {}),
    levelCurve: options.levelDb ? { windowSeconds: 1, db: options.levelDb } : null,
    sceneCuts: shots.slice(1).map((s) => ({ time: s.start, score: 0.8 })),
    shots,
    notes: [],
  };
}

/** Empirical-vs-target CDF distance (Kolmogorov-Smirnov) of `samples` against the piecewise-linear quantile curve. */
export function ksDistance(samples: number[], quantiles: number[]): number {
  const sorted = [...samples].sort((a, b) => a - b);
  const cdf = (x: number): number => {
    if (x <= (quantiles[0] as number)) return 0;
    if (x >= (quantiles[quantiles.length - 1] as number)) return 1;
    for (let i = 1; i < quantiles.length; i++) {
      const lo = quantiles[i - 1] as number;
      const hi = quantiles[i] as number;
      if (x <= hi) return ((i - 1) + (hi === lo ? 1 : (x - lo) / (hi - lo))) / (quantiles.length - 1);
    }
    return 1;
  };
  let worst = 0;
  sorted.forEach((x, i) => {
    const f = cdf(x);
    worst = Math.max(worst, Math.abs(f - i / sorted.length), Math.abs(f - (i + 1) / sorted.length));
  });
  return worst;
}

/** Two-sample Kolmogorov-Smirnov distance. */
export function ksTwoSample(a: number[], b: number[]): number {
  const xs = [...new Set([...a, ...b])].sort((p, q) => p - q);
  const share = (values: number[], x: number): number => values.filter((v) => v <= x + 1e-9).length / values.length;
  return Math.max(...xs.map((x) => Math.abs(share(a, x) - share(b, x))));
}
