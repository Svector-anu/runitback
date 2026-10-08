import type { TranscriptWord } from "./types";

export interface WordRange {
  /** First word index, inclusive. */
  startWord: number;
  /** Last word index, inclusive. */
  endWord: number;
}

export interface SourceRange {
  startSeconds: number;
  endSeconds: number;
}

const ADJACENT_EPSILON_SECONDS = 1e-6;

/**
 * Source-time spans covering the given word ranges, widened by `padSeconds` on both sides. Padding never reaches
 * into a neighbouring word that is not part of the range, and is clamped to [0, durationSeconds]. Overlapping or
 * touching spans are merged. Ranges that fall outside the word list are ignored.
 */
export function sourceRangesForWords(input: {
  words: ReadonlyArray<TranscriptWord>; ranges: ReadonlyArray<WordRange>; padSeconds?: number; durationSeconds?: number;
}): SourceRange[] {
  const pad = Math.max(0, input.padSeconds ?? 0);
  const spans: SourceRange[] = [];
  for (const range of input.ranges) {
    const first = input.words[range.startWord];
    const last = input.words[range.endWord];
    if (!first || !last || range.endWord < range.startWord) continue;
    const before = input.words[range.startWord - 1];
    const after = input.words[range.endWord + 1];
    const floor = Math.max(0, before ? Math.min(before.endSeconds, first.startSeconds) : 0);
    const ceiling = Math.min(input.durationSeconds ?? Number.POSITIVE_INFINITY, after ? Math.max(after.startSeconds, last.endSeconds) : Number.POSITIVE_INFINITY);
    const startSeconds = Math.max(floor, first.startSeconds - pad);
    const endSeconds = Math.min(ceiling, Math.max(last.endSeconds, first.startSeconds) + pad);
    if (endSeconds > startSeconds) spans.push({ startSeconds, endSeconds });
  }
  spans.sort((a, b) => a.startSeconds - b.startSeconds);
  const merged: SourceRange[] = [];
  for (const span of spans) {
    const previous = merged[merged.length - 1];
    if (previous && span.startSeconds <= previous.endSeconds + ADJACENT_EPSILON_SECONDS) previous.endSeconds = Math.max(previous.endSeconds, span.endSeconds);
    else merged.push({ ...span });
  }
  return merged;
}
