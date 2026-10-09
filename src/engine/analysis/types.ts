/** All times are seconds (floats); all levels are dBFS unless named otherwise. */

export const MEDIA_ANALYSIS_VERSION = 1;

export interface TimeRange {
  start: number;
  end: number;
}

export interface SilenceRange extends TimeRange {
  /** Mean RMS level over the silent range, dBFS. */
  meanDb: number;
}

export interface LoudnessStats {
  /** Highest sample magnitude seen, dBFS. */
  peakDb: number;
  /** RMS over the whole file, dBFS. */
  rmsDb: number;
  /** Gated, unweighted approximation of integrated loudness (BS.1770 gating without K-weighting), dBFS. Not LUFS. */
  integratedApproxDb: number;
  /**
   * True integrated loudness: BS.1770 K-weighted and gated, LUFS. Only present when `loudnessStats` is given
   * K-weighted windows (see `IntegratedLoudnessAccumulator` / `computeKWeightedWindows`); additive alongside
   * `integratedApproxDb` rather than a rename, since existing callers only have the unweighted windows today.
   */
  integratedLufs?: number;
}

export interface Onset {
  time: number;
  /** 0..1, energy rise relative to ONSET_FULL_STRENGTH_DB. */
  strength: number;
}

export interface TempoEstimate {
  bpm: number;
  /** 0..1, normalised autocorrelation of the onset envelope at the chosen period. */
  confidence: number;
}

export type MotionLevel = "low" | "med" | "high";

export interface SceneCut {
  /** Presentation time of the first frame of the new shot. */
  time: number;
  /** 0..1 frame-signature distance across the cut. */
  score: number;
}

export interface ShotAnalysis extends TimeRange {
  motion: MotionLevel;
  /** Mean luminance-grid difference between consecutive sampled frames inside the shot, 0..1. */
  motionScore: number;
  /** Up to three "#rrggbb" colours, most common first. */
  dominantColors: string[];
}

export interface LevelCurve {
  windowSeconds: number;
  /** RMS level per window, dBFS (floored at SILENCE_FLOOR_DB). */
  db: number[];
}

export interface MediaAnalysis {
  assetId: string;
  /** Bump when algorithms change so cached results are discarded. */
  version: number;
  durationSeconds: number;
  hasAudio: boolean;
  hasVideo: boolean;
  silences: SilenceRange[];
  loudness: LoudnessStats | null;
  /** Energy-based heuristic, not speech recognition. */
  speechLikeRanges: TimeRange[];
  onsets: Onset[];
  tempoBpm?: number;
  tempoConfidence?: number;
  levelCurve: LevelCurve | null;
  sceneCuts: SceneCut[];
  shots: ShotAnalysis[];
  /** Human-readable caveats such as frame caps. */
  notes: string[];
}

export interface TimelineClipInput {
  id: string;
  mediaId?: string;
  start: number;
  end: number;
  /** Source offset at the clip start, seconds. */
  trimStart?: number;
  /** Source seconds consumed per timeline second. */
  rate?: number;
}

export type TimelineTrackKind = "video" | "audio" | "text" | "graphic" | "effect";

export interface TimelineTrackInput {
  id: string;
  kind: TimelineTrackKind;
  clips: TimelineClipInput[];
}

export interface PacingBucket {
  minSeconds: number;
  /** null = unbounded. */
  maxSeconds: number | null;
  count: number;
}

export interface TrackPacing {
  trackId: string;
  kind: TimelineTrackKind;
  clipCount: number;
  cutLengths: number[];
  averageLength: number;
  gapSeconds: number;
}

export interface TimelineAnalysis {
  durationSeconds: number;
  tracks: TrackPacing[];
  /** Mean clip length over video-kind tracks. */
  averageShotLength: number;
  pacingHistogram: PacingBucket[];
  cutsPerMinute: number;
  /** Time with no video or audio clip active. */
  deadAirSeconds: number;
  deadAirRanges: TimeRange[];
  /** Pairs of clips on different tracks that intersect for a positive length. */
  overlapCount: number;
}

export interface LoudnessWindow {
  start: number;
  end: number;
  /** dBFS of the incoherent sum of active clips; SILENCE_FLOOR_DB when nothing plays. */
  db: number;
}
