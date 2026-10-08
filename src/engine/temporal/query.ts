import { searchTranscript } from "#/engine/transcript";
import { coverageRatio, levelStats, shotIndexAt } from "./measure";
import type { Moment, MomentQuery, MomentSort, SourceSpan, SpeechSegment, TemporalEvent, TemporalIndex } from "./types";

export const DEFAULT_MOMENT_LIMIT = 10;
/** A stretch counts as silent (or as speaking) when at least this share of it is. */
export const COVERAGE_THRESHOLD = 0.5;

interface Candidate extends SourceSpan {
  text?: string;
  matches: number;
  reason: string;
}

const seconds = (value: number): string => `${Math.round(value * 100) / 100}s`;

function sentenceAt(segments: ReadonlyArray<SpeechSegment>, wordIndex: number): number {
  return segments.findIndex((s) => s.startWord <= wordIndex && wordIndex <= s.endWord);
}

/** One candidate per run of sentences that contain the phrase; a phrase that straddles two sentences covers both. */
function textCandidates(index: TemporalIndex, phrase: string): Candidate[] {
  const { speech } = index.tracks;
  const found: Array<{ first: number; last: number }> = [];
  for (const match of searchTranscript({ words: index.words, query: phrase })) {
    const first = sentenceAt(speech, match.startWord);
    const last = sentenceAt(speech, match.endWord);
    if (first >= 0 && last >= 0) found.push({ first, last });
  }
  const groups: Array<{ first: number; last: number; matches: number }> = [];
  for (const hit of found) {
    const previous = groups[groups.length - 1];
    if (previous && hit.first <= previous.last) {
      previous.last = Math.max(previous.last, hit.last);
      previous.matches++;
    } else groups.push({ ...hit, matches: 1 });
  }
  return groups.map((g) => {
    const first = speech[g.first] as SpeechSegment;
    const last = speech[g.last] as SpeechSegment;
    return {
      startSeconds: first.startSeconds, endSeconds: last.endSeconds,
      text: speech.slice(g.first, g.last + 1).map((s) => s.text).join(" "),
      matches: g.matches,
      reason: `says "${phrase}"${g.matches > 1 ? ` (${g.matches}x)` : ""}`,
    };
  });
}

function speechEvents(index: TemporalIndex): ReadonlyArray<TemporalEvent> {
  return index.sources.transcript ? index.tracks.speech : index.tracks.speechLike;
}

function baseCandidates(index: TemporalIndex, query: MomentQuery): Candidate[] {
  if (query.text !== undefined && query.text.trim() !== "") return textCandidates(index, query.text);
  if (query.silent === true) {
    return index.tracks.silence.map((s) => ({ startSeconds: s.startSeconds, endSeconds: s.endSeconds, matches: 0, reason: `silence of ${seconds(s.endSeconds - s.startSeconds)}` }));
  }
  if (query.speaking === true) {
    return index.tracks.speech.length > 0 || index.sources.transcript
      ? index.tracks.speech.map((s) => ({ startSeconds: s.startSeconds, endSeconds: s.endSeconds, text: s.text, matches: 0, reason: "speech" }))
      : index.tracks.speechLike.map((s) => ({ startSeconds: s.startSeconds, endSeconds: s.endSeconds, matches: 0, reason: "speech-like audio" }));
  }
  return index.shots.map((s) => ({ startSeconds: s.startSeconds, endSeconds: s.endSeconds, matches: 0, reason: `shot ${s.index}` }));
}

function clipTo(candidate: Candidate, limit: SourceSpan | undefined): Candidate | null {
  if (!limit) return candidate;
  const startSeconds = Math.max(candidate.startSeconds, limit.startSeconds);
  const endSeconds = Math.min(candidate.endSeconds, limit.endSeconds);
  return endSeconds > startSeconds ? { ...candidate, startSeconds, endSeconds } : null;
}

const byTime = (a: SourceSpan, b: SourceSpan): number => a.startSeconds - b.startSeconds || a.endSeconds - b.endSeconds;

const nullsLast = (a: number | null, b: number | null, direction: 1 | -1): number => {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return direction * (a - b);
};

/** Deterministic ordering: the chosen key first, then asset id (when moments of several assets are mixed), then source time. */
export function rankMoments<T extends Moment & { assetId?: string }>(moments: ReadonlyArray<T>, sort: MomentSort): T[] {
  const compare = (a: T, b: T): number => {
    switch (sort) {
      case "relevance": return b.matches - a.matches;
      case "loudest": return nullsLast(a.loudnessDb, b.loudnessDb, -1);
      case "quietest": return nullsLast(a.loudnessDb, b.loudnessDb, 1);
      case "longest": return (b.endSeconds - b.startSeconds) - (a.endSeconds - a.startSeconds);
      case "time": return 0;
    }
  };
  return [...moments].sort((a, b) => compare(a, b) || (a.assetId ?? "").localeCompare(b.assetId ?? "") || byTime(a, b));
}

/**
 * Moments of one asset that satisfy every given filter. What a moment IS depends on the query: sentences containing
 * `text`, else silences for `silent:true`, else sentences for `speaking:true`, else whole shots. `shot` and
 * `sourceRange` clip candidates; the loudness, silent and speaking filters then test the clipped span.
 */
export function findMoments(index: TemporalIndex, query: MomentQuery = {}): Moment[] {
  const shotLimit = query.shot === undefined ? undefined : index.shots[query.shot];
  if (query.shot !== undefined && !shotLimit) return [];
  const speaking = speechEvents(index);
  const moments: Moment[] = [];
  for (const base of baseCandidates(index, query)) {
    const inShot = clipTo(base, shotLimit);
    const candidate = inShot && clipTo(inShot, query.sourceRange);
    if (!candidate) continue;
    const level = levelStats(index.levels, candidate);
    const loudnessDb = level?.meanDb ?? null;
    if (query.minLoudnessDb !== undefined && (loudnessDb === null || loudnessDb < query.minLoudnessDb)) continue;
    if (query.maxLoudnessDb !== undefined && (loudnessDb === null || loudnessDb > query.maxLoudnessDb)) continue;
    if (query.silent !== undefined) {
      const isSilent = coverageRatio(index.tracks.silence, candidate) >= COVERAGE_THRESHOLD;
      if (isSilent !== query.silent) continue;
    }
    if (query.speaking !== undefined) {
      const isSpeaking = coverageRatio(speaking, candidate) >= COVERAGE_THRESHOLD;
      if (isSpeaking !== query.speaking) continue;
    }
    moments.push({
      startSeconds: candidate.startSeconds, endSeconds: candidate.endSeconds,
      shotIndex: shotIndexAt(index.shots, (candidate.startSeconds + candidate.endSeconds) / 2),
      ...(candidate.text === undefined ? {} : { text: candidate.text }),
      loudnessDb, reason: candidate.reason, matches: candidate.matches,
    });
  }
  const ranked = rankMoments(moments, query.sort ?? "relevance");
  return ranked.slice(0, Math.max(0, Math.floor(query.limit ?? DEFAULT_MOMENT_LIMIT)));
}
