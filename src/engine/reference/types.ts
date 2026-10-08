/** All times are seconds, all levels dBFS, all ratios 0..1 unless named otherwise. */

export const STYLE_PROFILE_VERSION = 1;

export type RhythmClass = "fast-montage" | "steady" | "slow-burn";
export type CutTrend = "accelerating" | "steady" | "decelerating";
export type LoudnessShape = "flat" | "rising" | "falling" | "peaked" | "dipped";

export interface LengthBin {
  minSeconds: number;
  /** null = unbounded. */
  maxSeconds: number | null;
  /** Share of shots in this bin, 0..1. */
  fraction: number;
}

export interface ShotStats {
  count: number;
  meanSeconds: number;
  medianSeconds: number;
  p10Seconds: number;
  p90Seconds: number;
  /** Shot length at QUANTILE_LEVELS (0%, 5%, ... 100%); the planner samples from this curve. */
  quantiles: number[];
  histogram: LengthBin[];
  rhythm: RhythmClass;
  cutsPerMinute: number;
  /** Mean length of the first shot across sources: how long the opening holds before the first cut. */
  hookSeconds: number;
}

export interface CutDensity {
  openingPerMinute: number;
  middlePerMinute: number;
  endPerMinute: number;
  trend: CutTrend;
}

export interface BeatLock {
  /** Share of cuts that land within `toleranceSeconds` of a beat (tempo grid, or strong onsets without tempo). */
  score: number;
  toleranceSeconds: number;
  tempoBpm: number | null;
  tempoConfidence: number;
  cutsMeasured: number;
  /** False when no source had usable audio timing, so `score` carries no information. */
  beatsAvailable: boolean;
}

export interface AudioStyle {
  loudnessShape: LoudnessShape | null;
  silenceRatio: number;
  /** Spread between loud and quiet passages (95th minus 10th percentile of the level curve), dB. */
  dynamicRangeDb: number | null;
  integratedApproxDb: number | null;
}

export interface ColourStyle {
  /** Up to five "#rrggbb" colours, most frequent first (coarsely quantised). */
  palette: string[];
  /** Spread of shot brightness, 0..1. */
  contrast: number;
  /** Mean HSV saturation of shot colours, 0..1. */
  saturation: number;
  /** Mean relative luminance of shot colours, 0..1. */
  brightness: number;
}

export interface TextStyle {
  clipsPerMinute: number;
  meanDurationSeconds: number;
  /** Share of the reference's duration with any text on screen. */
  coverage: number;
}

export interface StyleProfile {
  version: number;
  sourceIds: string[];
  totalSeconds: number;
  shots: ShotStats;
  cutDensity: CutDensity;
  beatLock: BeatLock;
  audio: AudioStyle | null;
  colour: ColourStyle | null;
  text: TextStyle | null;
}

export interface StyleProfileOptions {
  /** Cut-to-beat tolerance in seconds. Default 0.08. */
  beatToleranceSeconds?: number;
  /** Text on screen in the reference(s), pooled across sources; enables `StyleProfile.text`. */
  textClips?: ReadonlyArray<{ start: number; end: number }>;
}

export interface SourceRange {
  assetId: string;
  start: number;
  end: number;
}

export interface PlannedShot {
  assetId: string;
  /** Source in/out, seconds. */
  in: number;
  out: number;
  /** Position on the timeline relative to the plan start, seconds. */
  start: number;
  duration: number;
}

export interface CutPlan {
  shots: PlannedShot[];
  totalSeconds: number;
  beatSnapped: boolean;
  snappedCuts: number;
  notes: string[];
}
