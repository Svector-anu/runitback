import type { LevelCurve, MotionLevel } from "#/engine/analysis";
import type { TranscriptWord } from "#/engine/transcript";

/** All times are seconds in SOURCE time of the asset; all levels are dBFS. */

export const TEMPORAL_INDEX_VERSION = 1;

/** Anything that happens over a span of source time. Instants (onsets) have start === end. */
export interface TemporalEvent {
  startSeconds: number;
  endSeconds: number;
  /** What it is, e.g. a face id or a visual tag. Core tracks leave it unset. */
  label?: string;
  /** 0..1 confidence or strength when the producer has one. */
  score?: number;
}

export interface IndexShot extends TemporalEvent {
  index: number;
  /** Mean level over the shot (power average of the level curve), null when the asset has no measurable audio. */
  loudnessMeanDb: number | null;
  /** Loudest level window inside the shot, null without audio. */
  loudnessPeakDb: number | null;
  /** Share of the shot covered by detected silences, 0..1; null without audio. */
  silenceRatio: number | null;
  speechWordCount: number;
  wordsPerSecond: number;
  motion?: MotionLevel;
}

export interface SpeechSegment extends TemporalEvent {
  index: number;
  /** Word index range into the transcript, inclusive; stable across timeline edits. */
  startWord: number;
  endWord: number;
  text: string;
  shotIndex: number;
}

export interface SilenceSpan extends TemporalEvent {
  meanDb: number;
}

export interface OnsetEvent extends TemporalEvent {
  score: number;
}

export interface BeatGrid {
  bpm: number;
  periodSeconds: number;
  /** Time of the first beat, 0 <= firstBeatSeconds < periodSeconds. */
  firstBeatSeconds: number;
  confidence: number;
}

export interface RhythmSummary {
  onsetCount: number;
  /** Up to STRONG_ONSET_LIMIT of the strongest onsets, ascending by time. */
  strongOnsets: number[];
  beatGrid?: BeatGrid;
}

/**
 * Event tracks on the shared source-time axis. The named tracks are filled by `buildTemporalIndex`; a producer such
 * as a face detector or an embedding matcher adds its own kind (`tracks.face`, `tracks.visual`) and consumers that
 * only know the core kinds keep working because they ignore keys they do not recognise.
 */
export interface TemporalTracks {
  speech: SpeechSegment[];
  /** Energy-based speech-like ranges; used for "speaking" when there is no transcript. */
  speechLike: TemporalEvent[];
  silence: SilenceSpan[];
  onset: OnsetEvent[];
  [kind: string]: TemporalEvent[];
}

export interface TemporalIndex {
  version: typeof TEMPORAL_INDEX_VERSION;
  assetId: string;
  durationSeconds: number;
  sources: { analysis: boolean; transcript: boolean; audio: boolean; visual?: boolean };
  shots: IndexShot[];
  tracks: TemporalTracks;
  /** Transcript words (empty without a transcript); phrase queries search these. */
  words: TranscriptWord[];
  levels: LevelCurve | null;
  rhythm: RhythmSummary | null;
}

export interface SourceSpan {
  startSeconds: number;
  endSeconds: number;
}

export type MomentSort = "relevance" | "time" | "loudest" | "quietest" | "longest";

export interface MomentQuery {
  /** Word or phrase said in the footage (case and punctuation ignored). Moments are the sentences that contain it. */
  text?: string;
  /** Restrict to this shot (index into `shots`). */
  shot?: number;
  minLoudnessDb?: number;
  maxLoudnessDb?: number;
  /** true: only (mostly) silent stretches; false: exclude them. */
  silent?: boolean;
  /** true: only stretches where someone speaks; false: exclude them. */
  speaking?: boolean;
  sourceRange?: SourceSpan;
  sort?: MomentSort;
  limit?: number;
}

export interface Moment extends SourceSpan {
  shotIndex: number;
  text?: string;
  /** Mean level over the moment, null when unknown. */
  loudnessDb: number | null;
  reason: string;
  /** Number of phrase matches inside a text moment; 0 otherwise. */
  matches: number;
}
