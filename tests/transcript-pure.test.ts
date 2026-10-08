import { describe, expect, it } from "vitest";
import {
  groupSentences, normalizeToken, searchTranscript, sourceRangesForWords, wordsToCaptionChunks, type TranscriptWord,
} from "#/engine/transcript";
import { TALK_WORDS, word } from "./transcript-harness";

describe("normalizeToken", () => {
  it("lowercases and drops punctuation and apostrophes", () => {
    // #given #when #then
    expect(normalizeToken("Don't,")).toBe("dont");
    expect(normalizeToken("...")).toBe("");
    expect(normalizeToken("Café!")).toBe("café");
  });
});

describe("searchTranscript", () => {
  it("finds a phrase ignoring case and punctuation and reports word indices and source seconds", () => {
    // #given
    const query = "SKIP this, part";
    // #when
    const [match, ...rest] = searchTranscript({ words: TALK_WORDS, query });
    // #then
    expect(rest).toEqual([]);
    expect(match).toMatchObject({ startWord: 5, endWord: 7, startSeconds: 3.0, endSeconds: 4.2, text: "skip this part." });
  });

  it("finds a single word", () => {
    expect(searchTranscript({ words: TALK_WORDS, query: "thanks" }).map((m) => m.startWord)).toEqual([8]);
  });

  it("returns non-overlapping matches left to right and honours maxResults", () => {
    // #given
    const words = ["a", "a", "a", "a", "a"].map((t, i) => word(t, i, i + 0.5));
    // #when
    const all = searchTranscript({ words, query: "a a" });
    const limited = searchTranscript({ words, query: "a a", maxResults: 1 });
    // #then
    expect(all.map((m) => [m.startWord, m.endWord])).toEqual([[0, 1], [2, 3]]);
    expect(limited).toHaveLength(1);
  });

  it("skips punctuation-only words inside a phrase and returns nothing for empty or absent queries", () => {
    const words = [word("well", 0, 0.3), word("-", 0.3, 0.35), word("okay", 0.4, 0.7)];
    expect(searchTranscript({ words, query: "well okay" })).toHaveLength(1);
    expect(searchTranscript({ words, query: "  ,, " })).toEqual([]);
    expect(searchTranscript({ words, query: "okay well" })).toEqual([]);
    expect(searchTranscript({ words: [], query: "x" })).toEqual([]);
  });
});

describe("groupSentences", () => {
  it("splits at terminal punctuation", () => {
    // #given #when
    const sentences = groupSentences({ words: TALK_WORDS });
    // #then
    expect(sentences.map((s) => [s.startWord, s.endWord])).toEqual([[0, 1], [2, 7], [8, 10]]);
    expect(sentences[1]).toMatchObject({ text: "We should probably skip this part.", startSeconds: 1.5, endSeconds: 4.2 });
  });

  it("splits at a long pause without punctuation and keeps a short pause together", () => {
    // #given
    const words = [word("so", 0, 0.3), word("yeah", 0.5, 0.8), word("then", 2.5, 2.8), word("we", 3, 3.2)];
    // #when
    const sentences = groupSentences({ words });
    // #then
    expect(sentences.map((s) => s.text)).toEqual(["so yeah", "then we"]);
    expect(groupSentences({ words, pauseSeconds: 5 })).toHaveLength(1);
  });

  it("treats closing quotes after a full stop as the end and handles empty input", () => {
    expect(groupSentences({ words: [word('go."', 0, 1), word("ok", 1.1, 1.5)] })).toHaveLength(2);
    expect(groupSentences({ words: [] })).toEqual([]);
  });
});

describe("wordsToCaptionChunks", () => {
  it("breaks at sentence ends and keeps indices aligned with the words", () => {
    // #given #when
    const chunks = wordsToCaptionChunks({ words: TALK_WORDS, maxChars: 200 });
    // #then
    expect(chunks.map((c) => [c.startWord, c.endWord])).toEqual([[0, 1], [2, 7], [8, 10]]);
  });

  it("wraps at maxChars and at maxSeconds", () => {
    // #given
    const words: TranscriptWord[] = "one two three four five six".split(" ").map((t, i) => word(t, i * 0.4, i * 0.4 + 0.35));
    // #when
    const byChars = wordsToCaptionChunks({ words, maxChars: 8, pauseSeconds: 10 });
    const bySeconds = wordsToCaptionChunks({ words, maxChars: 200, maxSeconds: 1, pauseSeconds: 10 });
    // #then
    expect(byChars.map((c) => c.text)).toEqual(["one two", "three", "four", "five six"]);
    expect(bySeconds.every((c) => c.endSeconds - c.startSeconds <= 1)).toBe(true);
    expect(bySeconds.flatMap((c) => c.text.split(" ")).join(" ")).toBe("one two three four five six");
  });

  it("emits an oversized single word on its own and ignores blank words", () => {
    const chunks = wordsToCaptionChunks({ words: [word("supercalifragilistic", 0, 1), word(" ", 1, 1.1), word("ok", 1.2, 1.5)], maxChars: 8 });
    expect(chunks.map((c) => c.text)).toEqual(["supercalifragilistic", "ok"]);
  });
});

describe("sourceRangesForWords", () => {
  it("pads both sides but never into neighbouring words", () => {
    // #given: "We" ends 1.7, "should" 1.8-2.2, "probably" starts 2.3
    // #when
    const ranges = sourceRangesForWords({ words: TALK_WORDS, ranges: [{ startWord: 3, endWord: 3 }], padSeconds: 0.5 });
    // #then
    expect(ranges).toEqual([{ startSeconds: 1.7, endSeconds: 2.3 }]);
  });

  it("applies the exact padding when there is room", () => {
    const [range] = sourceRangesForWords({ words: TALK_WORDS, ranges: [{ startWord: 8, endWord: 10 }], padSeconds: 0.1 });
    expect(range?.startSeconds).toBeCloseTo(4.9, 9);
    expect(range?.endSeconds).toBeCloseTo(6.4, 9);
  });

  it("clamps to zero and to the media duration", () => {
    const first = sourceRangesForWords({ words: TALK_WORDS, ranges: [{ startWord: 0, endWord: 0 }], padSeconds: 1 });
    const last = sourceRangesForWords({ words: TALK_WORDS, ranges: [{ startWord: 10, endWord: 10 }], padSeconds: 5, durationSeconds: 6.5 });
    expect(first[0]?.startSeconds).toBe(0);
    expect(last[0]?.endSeconds).toBe(6.5);
  });

  it("merges overlapping and touching spans and keeps separate ones apart", () => {
    // #given: words 5-6 and 6-7 overlap; word 9 is far away
    const ranges = sourceRangesForWords({
      words: TALK_WORDS, padSeconds: 0,
      ranges: [{ startWord: 9, endWord: 9 }, { startWord: 6, endWord: 7 }, { startWord: 5, endWord: 6 }],
    });
    // #then
    expect(ranges).toEqual([{ startSeconds: 3.0, endSeconds: 4.2 }, { startSeconds: 5.5, endSeconds: 5.6 }]);
  });

  it("merges ranges whose padded edges meet", () => {
    // #given: gap between "this" (3.6) and "part." (3.7) closed by padding
    const ranges = sourceRangesForWords({ words: TALK_WORDS, padSeconds: 0.05, ranges: [{ startWord: 5, endWord: 6 }, { startWord: 7, endWord: 7 }] });
    expect(ranges).toHaveLength(1);
  });

  it("ignores ranges outside the word list or reversed", () => {
    expect(sourceRangesForWords({ words: TALK_WORDS, ranges: [{ startWord: 20, endWord: 21 }, { startWord: 4, endWord: 3 }, { startWord: -1, endWord: 0 }] })).toEqual([]);
  });
});
