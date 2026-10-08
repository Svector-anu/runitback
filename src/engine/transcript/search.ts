import { normalizeToken, tokenizeQuery } from "./normalize";
import type { TranscriptWord } from "./types";

export interface TranscriptMatch {
  /** Index of the first matched word in the searched array. */
  startWord: number;
  /** Index of the last matched word, inclusive. */
  endWord: number;
  /** The matched words as transcribed, punctuation included. */
  text: string;
  startSeconds: number;
  endSeconds: number;
}

/**
 * Finds a phrase (or a single word) in order, ignoring case and punctuation. Words that are only punctuation are
 * skipped, so "well - okay" matches "well okay". Matches never overlap; scanning is left to right.
 */
export function searchTranscript(input: { words: ReadonlyArray<TranscriptWord>; query: string; maxResults?: number }): TranscriptMatch[] {
  const tokens = tokenizeQuery(input.query);
  if (tokens.length === 0) return [];
  const spoken: Array<{ index: number; token: string }> = [];
  input.words.forEach((word, index) => {
    const token = normalizeToken(word.text);
    if (token !== "") spoken.push({ index, token });
  });
  const limit = input.maxResults ?? Number.POSITIVE_INFINITY;
  const matches: TranscriptMatch[] = [];
  for (let at = 0; at + tokens.length <= spoken.length && matches.length < limit; at++) {
    if (!tokens.every((token, offset) => spoken[at + offset]?.token === token)) continue;
    const first = spoken[at] as { index: number };
    const last = spoken[at + tokens.length - 1] as { index: number };
    const words = input.words.slice(first.index, last.index + 1);
    matches.push({
      startWord: first.index,
      endWord: last.index,
      text: words.map((w) => w.text).join(" "),
      startSeconds: (input.words[first.index] as TranscriptWord).startSeconds,
      endSeconds: (input.words[last.index] as TranscriptWord).endSeconds,
    });
    at += tokens.length - 1;
  }
  return matches;
}
