/** Pure maths behind the per-word text effects (stagger, highlight) and the typing caret; shared by preview and export. */

export interface WordSpan {
  /** Index of the word across the whole text, counting from 0. */
  index: number;
  /** UTF-16 offsets into the line: `start` inclusive, `end` exclusive. */
  start: number;
  end: number;
}

/** Words of one line (runs of non-whitespace); `firstIndex` is the index of the line's first word within the whole text. */
export function wordSpans(input: { line: string; firstIndex: number }): WordSpan[] {
  const spans: WordSpan[] = [];
  const pattern = /\S+/g;
  for (let match = pattern.exec(input.line); match; match = pattern.exec(input.line)) {
    spans.push({ index: input.firstIndex + spans.length, start: match.index, end: match.index + match[0].length });
  }
  return spans;
}

/** Number of words on each line, so a word's index can be offset by the lines before it. */
export function wordCounts(lines: ReadonlyArray<string>): number[] {
  return lines.map((line) => wordSpans({ line, firstIndex: 0 }).length);
}

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));
const easeOut = (t: number): number => 1 - (1 - t) ** 3;

/**
 * Entrance progress of word `index` of `count` when the stagger as a whole is at `progress` (0..1). Every word runs
 * for two "slots" of the timeline and starts one slot after the previous one, so neighbours overlap by half and the
 * last word finishes exactly at progress 1.
 */
export function staggerWordProgress(input: { index: number; count: number; progress: number }): number {
  const { index, count } = input;
  if (count <= 0) return 1;
  const slots = count + 1;
  return easeOut(clamp01((clamp01(input.progress) * slots - index) / 2));
}

/** Highlight colour applies to this word? `sweep` keeps every earlier word lit as the highlight moves on. */
export function isWordHighlighted(input: { index: number; highlightWord: number; sweep: boolean }): boolean {
  if (input.highlightWord < 0) return false;
  return input.sweep ? input.index <= input.highlightWord : input.index === input.highlightWord;
}

export const CARET_BLINK_PERIOD_SECONDS = 1;

/** The caret stays solid while text is still being typed, then blinks with a 50 % duty cycle. */
export function caretVisible(input: { typing: boolean; seconds: number }): boolean {
  if (input.typing) return true;
  const phase = ((input.seconds % CARET_BLINK_PERIOD_SECONDS) + CARET_BLINK_PERIOD_SECONDS) % CARET_BLINK_PERIOD_SECONDS;
  return phase < CARET_BLINK_PERIOD_SECONDS / 2;
}
