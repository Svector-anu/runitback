import type { MediaAnalysis } from "#/engine/analysis";
import { faceShotStats, type FaceDetections } from "#/engine/face";
import { beatTimes } from "#/engine/reference";
import { groupSentences, type Transcript } from "#/engine/transcript";
import { faceEvents } from "./faces";
import { coverageRatio, levelStats, shotIndexAt } from "./measure";
import { visualEvents, type VisualTrackInput } from "./visual";
import {
  TEMPORAL_INDEX_VERSION, type BeatGrid, type IndexShot, type OnsetEvent, type RhythmSummary, type SilenceSpan, type SpeechSegment, type TemporalIndex,
} from "./types";

/** Scene cuts closer than this to the previous boundary are detector noise, not shots. */
const MIN_SHOT_SECONDS = 0.05;
const STRONG_ONSET_LIMIT = 16;
/** Same threshold the reference beat grid uses before it trusts a tempo estimate. */
const MIN_TEMPO_CONFIDENCE = 0.2;

function shotBoundaries(analysis: MediaAnalysis | undefined, duration: number): number[] {
  const cuts = (analysis?.sceneCuts ?? []).map((c) => c.time).filter((t) => t > 0 && t < duration).sort((a, b) => a - b);
  const bounds = [0];
  for (const cut of cuts) if (cut - (bounds[bounds.length - 1] as number) >= MIN_SHOT_SECONDS) bounds.push(cut);
  if (duration - (bounds[bounds.length - 1] as number) < MIN_SHOT_SECONDS && bounds.length > 1) bounds.pop();
  bounds.push(duration);
  return bounds;
}

function rhythmOf(analysis: MediaAnalysis): RhythmSummary | null {
  const bpm = analysis.tempoBpm;
  const hasGrid = bpm !== undefined && bpm > 0 && (analysis.tempoConfidence ?? 0) >= MIN_TEMPO_CONFIDENCE;
  if (analysis.onsets.length === 0 && !hasGrid) return null;
  const strongest = [...analysis.onsets].sort((a, b) => b.strength - a.strength || a.time - b.time).slice(0, STRONG_ONSET_LIMIT);
  let beatGrid: BeatGrid | undefined;
  if (hasGrid) {
    const first = beatTimes(analysis)[0];
    const period = 60 / bpm;
    beatGrid = { bpm, periodSeconds: period, firstBeatSeconds: first ?? 0, confidence: analysis.tempoConfidence ?? 0 };
  }
  return { onsetCount: analysis.onsets.length, strongOnsets: strongest.map((o) => o.time).sort((a, b) => a - b), ...(beatGrid ? { beatGrid } : {}) };
}

/**
 * Joins what is known about one asset on its source-time axis: shots (from scene cuts), loudness and silence per
 * shot, speech sentences, silences and rhythm. Missing inputs leave their parts empty and `sources` says which
 * inputs were present, so a consumer can tell "no speech" from "never transcribed". Visual embeddings, when given, add
 * `tracks.visual` (see `visualEvents`). Face detections, when given, add `tracks.face` (one event per continuous
 * appearance of a tracked face) and `faces` statistics on every shot.
 */
export function buildTemporalIndex(input: { assetId: string; duration: number; analysis?: MediaAnalysis; transcript?: Transcript; visual?: VisualTrackInput; faces?: FaceDetections }): TemporalIndex {
  const { analysis, transcript } = input;
  const duration = Math.max(0, input.duration);
  const words = transcript?.words ?? [];

  const silence: SilenceSpan[] = (analysis?.silences ?? [])
    .map((s) => ({ startSeconds: s.start, endSeconds: s.end, meanDb: s.meanDb }))
    .sort((a, b) => a.startSeconds - b.startSeconds);
  const onset: OnsetEvent[] = (analysis?.onsets ?? []).map((o) => ({ startSeconds: o.time, endSeconds: o.time, score: o.strength })).sort((a, b) => a.startSeconds - b.startSeconds);
  const speechLike = (analysis?.speechLikeRanges ?? []).map((r) => ({ startSeconds: r.start, endSeconds: r.end })).sort((a, b) => a.startSeconds - b.startSeconds);
  const levels = analysis?.levelCurve ?? null;
  const hasAudio = analysis ? analysis.hasAudio : words.length > 0;

  const bounds = shotBoundaries(analysis, duration);
  const shots: IndexShot[] = bounds.slice(0, -1).map((start, index) => {
    const end = bounds[index + 1] as number;
    const span = { startSeconds: start, endSeconds: end };
    const stats = hasAudio ? levelStats(levels, span) : null;
    const wordCount = words.filter((w) => {
      const mid = (w.startSeconds + w.endSeconds) / 2;
      return mid >= start && (mid < end || (index === bounds.length - 2 && mid <= end));
    }).length;
    const length = end - start;
    const motion = analysis?.shots.find((s) => s.start <= (start + end) / 2 && (start + end) / 2 < s.end)?.motion;
    return {
      ...span, index,
      loudnessMeanDb: stats?.meanDb ?? null,
      loudnessPeakDb: stats?.peakDb ?? null,
      silenceRatio: analysis && analysis.hasAudio ? coverageRatio(silence, span) : null,
      speechWordCount: wordCount,
      wordsPerSecond: length > 0 ? wordCount / length : 0,
      ...(motion ? { motion } : {}),
    };
  });

  const faceStats = input.faces ? faceShotStats({ detections: input.faces, spans: shots }) : undefined;
  const shotsWithFaces = faceStats ? shots.map((shot, i) => (faceStats[i] ? { ...shot, faces: faceStats[i] } : shot)) : shots;

  const speech: SpeechSegment[] = groupSentences({ words }).map((s, index) => ({
    index, startSeconds: s.startSeconds, endSeconds: s.endSeconds, startWord: s.startWord, endWord: s.endWord, text: s.text,
    shotIndex: shotIndexAt(shots, (s.startSeconds + s.endSeconds) / 2),
  }));

  return {
    version: TEMPORAL_INDEX_VERSION,
    assetId: input.assetId,
    durationSeconds: duration,
    sources: { analysis: analysis !== undefined, transcript: transcript !== undefined, audio: hasAudio, ...(input.visual ? { visual: true } : {}), ...(input.faces ? { faces: true } : {}) },
    shots: shotsWithFaces,
    tracks: { speech, speechLike, silence, onset, ...(input.visual ? { visual: visualEvents(input.visual) } : {}),
      ...(input.faces ? { face: faceEvents({ detections: input.faces, cuts: bounds.slice(1, -1) }) } : {}),
    },
    words,
    levels,
    rhythm: analysis ? rhythmOf(analysis) : null,
  };
}
