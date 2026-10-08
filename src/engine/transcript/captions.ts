import { endsSentence } from "./sentences";
import type { TranscriptWord } from "./types";

export const DEFAULT_CAPTION_MAX_CHARS = 32;
export const DEFAULT_CAPTION_MAX_SECONDS = 3;
export const DEFAULT_CAPTION_PAUSE_SECONDS = 0.5;

export interface CaptionChunk {
  startWord: number;
  endWord: number;
  text: string;
  startSeconds: number;
  endSeconds: number;
}

/**
 * Greedy caption phrasing: a chunk closes at a sentence end, at a pause of `pauseSeconds` or more, or before a word
 * that would push it past `maxChars` or `maxSeconds`. A single long word still forms its own chunk.
 */
export function wordsToCaptionChunks(input: {
  words: ReadonlyArray<TranscriptWord>; maxChars?: number; maxSeconds?: number; pauseSeconds?: number;
}): CaptionChunk[] {
  const maxChars = input.maxChars ?? DEFAULT_CAPTION_MAX_CHARS;
  const maxSeconds = input.maxSeconds ?? DEFAULT_CAPTION_MAX_SECONDS;
  const pause = input.pauseSeconds ?? DEFAULT_CAPTION_PAUSE_SECONDS;
  const chunks: CaptionChunk[] = [];
  let from = -1;
  let text = "";
  const close = (to: number): void => {
    const first = input.words[from];
    const last = input.words[to];
    if (first && last) chunks.push({ startWord: from, endWord: to, text, startSeconds: first.startSeconds, endSeconds: last.endSeconds });
    from = -1;
    text = "";
  };
  input.words.forEach((word, index) => {
    const label = word.text.trim();
    if (label === "") return;
    const first = input.words[from];
    if (from >= 0 && first) {
      const joined = `${text} ${label}`;
      if (joined.length > maxChars || word.endSeconds - first.startSeconds > maxSeconds) close(index - 1);
    }
    if (from < 0) from = index;
    text = text === "" ? label : `${text} ${label}`;
    const next = input.words[index + 1];
    if (!next || endsSentence(word) || next.startSeconds - word.endSeconds >= pause) close(index);
  });
  return chunks;
}
