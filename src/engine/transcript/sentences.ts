import type { TranscriptWord } from "./types";

export const DEFAULT_SENTENCE_PAUSE_SECONDS = 0.8;

export interface TranscriptSentence {
  /** Index of the first word in the grouped array. */
  startWord: number;
  /** Index of the last word, inclusive. */
  endWord: number;
  text: string;
  startSeconds: number;
  endSeconds: number;
}

const SENTENCE_END = /[.!?…]["'”’)\]]*$/u;

export const endsSentence = (word: TranscriptWord): boolean => SENTENCE_END.test(word.text.trim());

/** Splits after terminal punctuation, or where the silence before the next word is at least `pauseSeconds`. */
export function groupSentences(input: { words: ReadonlyArray<TranscriptWord>; pauseSeconds?: number }): TranscriptSentence[] {
  const pause = input.pauseSeconds ?? DEFAULT_SENTENCE_PAUSE_SECONDS;
  const sentences: TranscriptSentence[] = [];
  let from = 0;
  const close = (to: number): void => {
    const words = input.words.slice(from, to + 1);
    const first = words[0];
    const last = words[words.length - 1];
    if (!first || !last) return;
    sentences.push({ startWord: from, endWord: to, text: words.map((w) => w.text).join(" "), startSeconds: first.startSeconds, endSeconds: last.endSeconds });
    from = to + 1;
  };
  input.words.forEach((word, index) => {
    const next = input.words[index + 1];
    if (!next) return close(index);
    if (endsSentence(word) || next.startSeconds - word.endSeconds >= pause) close(index);
  });
  return sentences;
}
