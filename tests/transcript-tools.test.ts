import { describe, expect, it } from "vitest";
import { createAgentTools } from "#/engine/agent";
import { allElements } from "#/engine/timeline";
import { PARAM } from "#/engine/model";
import type { Transcriber } from "#/engine/transcript";
import type { InsertedData } from "./agent-harness";
import { snapshotForUndo } from "./invariants-harness";
import { TALK_WORDS, coverage, playedSource, setupTranscript, transcriptOf, word, type TranscriptHarness } from "./transcript-harness";

interface Sentence { startWord: number; endWord: number; text: string; start: number; end: number }
interface SentencesData { sentences: Sentence[]; words?: Array<{ index: number; text: string; start: number; end: number }>; unit: string }
interface MatchesData { matches: Array<{ occurrence: number; startWord: number; endWord: number; text: string; start: number; end: number }>; unit: string }
interface DeleteData {
  deletedElementId: string; startWord: number; endWord: number; removed: { start: number; end: number; duration: number };
  durationSeconds: number; remainingClips: Array<{ elementId: string; start: number; end: number }>;
}

const FRAME = 1 / 30;

async function clip(h: TranscriptHarness, input: { start?: number; speed?: number; trimStart?: number; trimEnd?: number } = {}): Promise<InsertedData> {
  const inserted = await h.data<InsertedData>("insert_media", { assetId: "a1", ...(input.start === undefined ? {} : { start: input.start }) });
  if (input.trimStart !== undefined || input.trimEnd !== undefined) {
    await h.data("trim", { elementId: inserted.elementId, ...(input.trimStart === undefined ? {} : { start: input.trimStart + inserted.start }), ...(input.trimEnd === undefined ? {} : { end: input.trimEnd }) });
  }
  if (input.speed !== undefined) await h.data("set_speed", { elementId: inserted.elementId, speed: input.speed });
  return inserted;
}

/** Puts a 6 s lead-in clip first so later clips can start after 0 on the main track. */
async function leadIn(h: TranscriptHarness): Promise<void> {
  await h.data("insert_media", { assetId: "a3" });
}

const SPOKEN_AWAY: Array<[number, number]> = [[1.5, 4.2]];
const SPOKEN_KEPT: Array<[number, number]> = [[0, 0.9], [5.0, 6.3]];

function expectSpeechRemoved(h: TranscriptHarness, removed: ReadonlyArray<[number, number]>, kept: ReadonlyArray<[number, number]>): void {
  const played = playedSource(h.editor, "a1");
  for (const [a, b] of removed) expect(coverage(played, a, b), `source ${a}-${b} should be gone`).toBeCloseTo(0, 6);
  for (const [a, b] of kept) expect(coverage(played, a, b), `source ${a}-${b} should be intact`).toBeCloseTo(b - a, 6);
}

describe("registry", () => {
  it("is opt-in: the default registry has no transcript tools", () => {
    const names = [...createAgentTools().keys()];
    expect(names.filter((n) => /transcript|spoken/.test(n))).toEqual([]);
  });

  it("offers transcribe_asset only when a transcriber is injected", () => {
    const transcriber: Transcriber = { transcribe: async ({ assetId }) => transcriptOf(assetId, []) };
    expect([...setupTranscript().tools.keys()]).not.toContain("transcribe_asset");
    expect([...setupTranscript({ transcriber }).tools.keys()]).toContain("transcribe_asset");
  });

  it("flags the read tools read-only and the editing tools not", () => {
    const { tools } = setupTranscript();
    expect(["get_transcript", "search_transcript"].map((n) => tools.get(n)?.readOnly)).toEqual([true, true]);
    expect(["delete_spoken_range", "add_captions_from_transcript"].map((n) => tools.get(n)?.readOnly)).toEqual([false, false]);
  });
});

describe("get_transcript", () => {
  it("returns sentences with word indices and timeline seconds for a clip", async () => {
    // #given
    const h = setupTranscript();
    const { elementId } = await clip(h);
    // #when
    const data = await h.data<SentencesData>("get_transcript", { elementId });
    // #then
    expect(data.unit).toBe("timeline seconds");
    expect(data.sentences.map((s) => [s.startWord, s.endWord, s.start, s.end])).toEqual([[0, 1, 0, 0.9], [2, 7, 1.5, 4.2], [8, 10, 5, 6.3]]);
  });

  it("shifts times by the clip's start on the timeline", async () => {
    const h = setupTranscript();
    await leadIn(h);
    const { elementId } = await clip(h);
    const data = await h.data<SentencesData>("get_transcript", { elementId });
    expect(data.sentences[1]).toMatchObject({ start: 7.5, end: 10.2 });
  });

  it("excludes words outside the trimmed region and keeps global word indices", async () => {
    // #given: source 3.0-10 plays
    const h = setupTranscript();
    const { elementId } = await clip(h, { trimStart: 3 });
    // #when
    const data = await h.data<SentencesData>("get_transcript", { elementId, includeWords: true });
    // #then
    expect(data.words?.[0]).toMatchObject({ index: 5, text: "skip", start: 0 });
    expect(data.sentences.map((s) => [s.startWord, s.endWord])).toEqual([[5, 7], [8, 10]]);
  });

  it("excludes words after a trimmed tail", async () => {
    const h = setupTranscript();
    const { elementId } = await clip(h, { trimEnd: 4.5 });
    const data = await h.data<SentencesData>("get_transcript", { elementId });
    expect(data.sentences.at(-1)?.endWord).toBe(7);
  });

  it("divides times by the playback speed", async () => {
    // #given: 2x, so the clip lasts 5 s
    const h = setupTranscript();
    const { elementId } = await clip(h, { speed: 2 });
    // #when
    const data = await h.data<SentencesData>("get_transcript", { elementId });
    // #then
    expect(data.sentences[1]).toMatchObject({ start: 0.75, end: 2.1 });
    expect(data.sentences[2]).toMatchObject({ start: 2.5, end: 3.15 });
  });

  it("combines trim, speed and start", async () => {
    // #given: lead-in of 6 s, then a clip whose head (3 s of source) is trimmed off: trimming moves its left edge to 6 + 3, played at 0.5x
    const h = setupTranscript();
    await leadIn(h);
    const { elementId } = await clip(h, { trimStart: 3, speed: 0.5 });
    // #when
    const data = await h.data<SentencesData>("get_transcript", { elementId, includeWords: true });
    // #then
    const thanks = data.words?.find((w) => w.text === "Thanks");
    expect(data.words?.[0]).toMatchObject({ text: "skip", start: 9 });
    expect(thanks?.start).toBeCloseTo(9 + (5.0 - 3) / 0.5, 2);
  });

  it("returns source seconds for the whole transcript by asset id", async () => {
    const h = setupTranscript();
    const data = await h.data<SentencesData>("get_transcript", { assetId: "a1" });
    expect(data.unit).toBe("source seconds");
    expect(data.sentences).toHaveLength(3);
  });

  it("explains when no word plays in the clip", async () => {
    const h = setupTranscript({ words: [word("early", 0, 0.5)] });
    const { elementId } = await clip(h, { trimStart: 5 });
    const result = await h.call("get_transcript", { elementId });
    expect(result.ok && result.summary).toMatch(/No spoken words/);
  });

  it("fails with a hint for bad targets", async () => {
    const h = setupTranscript();
    const both = await h.failure("get_transcript", { elementId: "x", assetId: "a1" });
    const ghost = await h.failure("get_transcript", { elementId: "ghost" });
    const none = await h.failure("get_transcript", { assetId: "a2" });
    expect(both.hint).toMatch(/elementId/);
    expect(ghost.hint).toMatch(/get_timeline/);
    expect(none.error).toMatch(/No transcript/);
  });

  it("rejects clips without speech media and points at transcribe_asset when available", async () => {
    const transcriber: Transcriber = { transcribe: async ({ assetId }) => transcriptOf(assetId, []) };
    const h = setupTranscript({ transcriber });
    const text = await h.data<{ elementId: string }>("insert_text", { text: "hi", start: 0, duration: 2 });
    await clip(h, { start: 5 });
    await h.store.save(transcriptOf("a2", []));
    const textFailure = await h.failure("get_transcript", { elementId: text.elementId });
    const missing = await h.failure("get_transcript", { assetId: "a3" });
    expect(textFailure.error).toMatch(/no spoken words/);
    expect(missing.hint).toMatch(/transcribe_asset/);
  });
});

describe("search_transcript", () => {
  it("finds a phrase case- and punctuation-insensitively with timeline seconds", async () => {
    const h = setupTranscript();
    const { elementId } = await clip(h, { speed: 2 });
    const data = await h.data<MatchesData>("search_transcript", { elementId, query: "SKIP, this PART" });
    expect(data.matches).toHaveLength(1);
    expect(data.matches[0]).toMatchObject({ startWord: 5, endWord: 7, start: 1.5, end: 2.1 });
  });

  it("only searches words that play in the clip", async () => {
    const h = setupTranscript();
    const { elementId } = await clip(h, { trimStart: 3 });
    expect((await h.data<MatchesData>("search_transcript", { elementId, query: "hello" })).matches).toEqual([]);
    expect((await h.data<MatchesData>("search_transcript", { assetId: "a1", query: "hello" })).matches).toHaveLength(1);
  });

  it("numbers repeated matches and respects maxResults", async () => {
    const h = setupTranscript({ words: [word("go", 0, 0.3), word("go", 0.5, 0.8), word("go", 1, 1.3)] });
    const all = await h.data<MatchesData>("search_transcript", { assetId: "a1", query: "go" });
    const one = await h.data<MatchesData>("search_transcript", { assetId: "a1", query: "go", maxResults: 1 });
    expect(all.matches.map((m) => m.occurrence)).toEqual([1, 2, 3]);
    expect(one.matches).toHaveLength(1);
  });
});

describe("delete_spoken_range", () => {
  it("removes a spoken sentence and leaves a gap by default, as one undo step", async () => {
    // #given
    const h = setupTranscript();
    const { elementId } = await clip(h);
    const before = snapshotForUndo(h.editor);
    // #when
    const data = await h.data<DeleteData>("delete_spoken_range", { elementId, phrase: "we should probably skip this part" });
    // #then
    expectSpeechRemoved(h, SPOKEN_AWAY, SPOKEN_KEPT);
    expect(data.removed.start).toBeCloseTo(1.467, 2);
    expect(data.removed.end).toBeCloseTo(4.233, 2);
    expect(data.durationSeconds).toBe(10);
    expect(data.remainingClips.map((c) => [c.start, c.end])).toEqual([[0, 1.467], [4.233, 10]]);
    expect(h.editor.undo()).toBe(true);
    expect(snapshotForUndo(h.editor)).toBe(before);
    expect(h.editor.undo()).toBe(true);
  });

  it("closes the gap on that track when ripple is true", async () => {
    const h = setupTranscript();
    const { elementId } = await clip(h);
    const data = await h.data<DeleteData>("delete_spoken_range", { elementId, phrase: "we should probably skip this part", ripple: true });
    expect(data.durationSeconds).toBeCloseTo(10 - data.removed.duration, 2);
    const [left, right] = data.remainingClips;
    expect(right?.start).toBeCloseTo(left?.end ?? -1, 3);
    expectSpeechRemoved(h, SPOKEN_AWAY, SPOKEN_KEPT);
  });

  it("does not move clips on other tracks when rippling", async () => {
    const h = setupTranscript();
    const { elementId } = await clip(h);
    const title = await h.data<{ elementId: string }>("insert_text", { text: "title", start: 6, duration: 2 });
    await h.data("delete_spoken_range", { elementId, phrase: "skip this part", ripple: true });
    const moved = allElements(h.editor.tracks()).find((l) => l.element.id === title.elementId);
    expect(moved?.element.startTime).toBe(6 * 120000);
  });

  it("accepts a word index range and defaults endWord to startWord", async () => {
    const h = setupTranscript();
    const { elementId } = await clip(h);
    const data = await h.data<DeleteData>("delete_spoken_range", { elementId, startWord: 8 });
    expect([data.startWord, data.endWord]).toEqual([8, 8]);
    expectSpeechRemoved(h, [[5.0, 5.4]], [[0, 4.2], [5.5, 6.3]]);
  });

  it("honours playback speed", async () => {
    // #given
    const h = setupTranscript();
    const { elementId } = await clip(h, { speed: 2 });
    // #when
    const data = await h.data<DeleteData>("delete_spoken_range", { elementId, phrase: "we should probably skip this part", ripple: true });
    // #then: the 2.77 s of source is 1.38 s of timeline
    expect(data.removed.duration).toBeCloseTo(2.767 / 2, 1);
    expectSpeechRemoved(h, SPOKEN_AWAY, SPOKEN_KEPT);
    expect(data.durationSeconds).toBeCloseTo(5 - data.removed.duration, 2);
  });

  it("honours a trimmed head and a moved clip", async () => {
    const h = setupTranscript();
    await leadIn(h);
    const { elementId } = await clip(h, { trimStart: 3 });
    await h.data("delete_spoken_range", { elementId, startWord: 5, endWord: 7 });
    expectSpeechRemoved(h, [[3.0, 4.2]], [[5.0, 6.3]]);
  });

  it("clamps to the clip edges when the words touch the start or the trimmed end", async () => {
    // #given: clip ends exactly where the last word does
    const h = setupTranscript();
    const { elementId } = await clip(h, { trimEnd: 6.3 });
    // #when
    const tail = await h.data<DeleteData>("delete_spoken_range", { elementId, phrase: "watching" });
    const head = await h.data<DeleteData>("delete_spoken_range", { elementId, phrase: "hello" });
    // #then
    expect(tail.remainingClips.map((c) => c.elementId)).toContain(elementId);
    expect(head.removed.start).toBe(0);
    const clips = allElements(h.editor.tracks()).map((l) => l.element).filter((e) => "mediaId" in e);
    expect(clips.every((e) => e.duration > 0)).toBe(true);
  });

  it("removes the whole clip when the words cover all of it", async () => {
    const h = setupTranscript({ words: [word("hi", 0, 10)] });
    const { elementId } = await clip(h);
    await h.data("delete_spoken_range", { elementId, startWord: 0 });
    expect(allElements(h.editor.tracks()).some((l) => l.element.id === elementId)).toBe(false);
  });

  it("keeps working on the piece that holds the next words after an earlier cut", async () => {
    // #given
    const h = setupTranscript();
    const { elementId } = await clip(h);
    await h.data("delete_spoken_range", { elementId, phrase: "skip this part", ripple: true });
    // #when: the original id no longer plays "Thanks"
    const stale = await h.failure("delete_spoken_range", { elementId, startWord: 8, endWord: 10 });
    const other = allElements(h.editor.tracks()).map((l) => l.element.id).find((id) => id !== elementId) as string;
    await h.data("delete_spoken_range", { elementId: other, phrase: "thanks for watching" });
    // #then
    expect(stale.hint).toContain(other);
    expectSpeechRemoved(h, [[3.0, 4.2], [5.0, 6.3]], [[0, 0.9], [1.5, 2.9]]);
  });

  it("never eats a neighbouring word, even with large padding", async () => {
    const h = setupTranscript();
    const { elementId } = await clip(h);
    await h.data("delete_spoken_range", { elementId, phrase: "probably", padSeconds: 1 });
    expectSpeechRemoved(h, [[2.3, 2.9]], [[1.8 + FRAME, 2.2], [3.0, 3.3 - FRAME]]);
  });

  it("asks for an occurrence when the phrase is ambiguous and honours it", async () => {
    // #given
    const h = setupTranscript({ words: [word("um", 0, 0.3), word("so", 0.4, 0.7), word("um", 2, 2.3), word("done.", 2.4, 2.9)] });
    const { elementId } = await clip(h);
    // #when
    const ambiguous = await h.failure("delete_spoken_range", { elementId, phrase: "um" });
    await h.data("delete_spoken_range", { elementId, phrase: "um", occurrence: 2 });
    // #then
    expect(ambiguous.error).toMatch(/2 times/);
    expect(ambiguous.hint).toMatch(/occurrence/);
    expectSpeechRemoved(h, [[2, 2.3]], [[0, 0.3], [0.4, 0.7]]);
  });

  it("fails without changing anything on bad input", async () => {
    // #given
    const h = setupTranscript();
    const { elementId } = await clip(h);
    const before = snapshotForUndo(h.editor);
    // #when
    const failures = [
      await h.failure("delete_spoken_range", { elementId }),
      await h.failure("delete_spoken_range", { elementId, phrase: "a", startWord: 1 }),
      await h.failure("delete_spoken_range", { elementId, phrase: "banana" }),
      await h.failure("delete_spoken_range", { elementId, phrase: "hello", occurrence: 3 }),
      await h.failure("delete_spoken_range", { elementId, startWord: 5, endWord: 2 }),
      await h.failure("delete_spoken_range", { elementId, startWord: 99 }),
      await h.failure("delete_spoken_range", { elementId: "ghost", startWord: 0 }),
      await h.failure("delete_spoken_range", { elementId, startWord: 0, padSeconds: -1 }),
    ];
    // #then
    expect(failures.every((f) => f.error.length > 0 && f.hint.length > 0)).toBe(true);
    expect(snapshotForUndo(h.editor)).toBe(before);
  });
});

describe("add_captions_from_transcript", () => {
  it("creates timed caption text clips on a new top text track", async () => {
    // #given
    const h = setupTranscript();
    const { elementId } = await clip(h);
    // #when
    const data = await h.data<{ count: number; trackIds: string[]; captions: Array<{ elementId: string; text: string; start: number; end: number }> }>("add_captions_from_transcript", { elementId, maxChars: 40 });
    // #then
    expect(data.count).toBe(3);
    expect(data.trackIds).toHaveLength(1);
    expect(data.captions.map((c) => c.text)).toEqual(["Hello there.", "We should probably skip this part.", "Thanks for watching."]);
    expect(data.captions[1]?.start).toBeCloseTo(1.5, 1);
    const first = allElements(h.editor.tracks()).find((l) => l.element.id === data.captions[0]?.elementId);
    expect(first?.element.params[PARAM.content]).toContain("Hello");
    expect(first?.track.type).toBe("text");
    expect(h.editor.undo()).toBe(true);
    expect(allElements(h.editor.tracks()).filter((l) => l.track.type === "text")).toEqual([]);
  });

  it("times captions to the timeline for sped-up clips and limits to a word range", async () => {
    const h = setupTranscript();
    const { elementId } = await clip(h, { speed: 2 });
    const data = await h.data<{ captions: Array<{ text: string; start: number; end: number }> }>("add_captions_from_transcript", { elementId, startWord: 8, maxChars: 8 });
    expect(data.captions[0]).toMatchObject({ text: "Thanks" });
    expect(data.captions[0]?.start).toBeCloseTo(2.5, 1);
    expect(data.captions.map((c) => c.text).join(" ")).toBe("Thanks for watching.");
  });

  it("fails for clips without words in range", async () => {
    const h = setupTranscript();
    const { elementId } = await clip(h);
    const out = await h.failure("add_captions_from_transcript", { elementId, startWord: 50 });
    expect(out.hint).toMatch(/get_transcript/);
  });
});

describe("transcribe_asset", () => {
  function withTranscriber() {
    const calls: string[] = [];
    const transcriber: Transcriber = { transcribe: async ({ assetId }) => { calls.push(assetId); return transcriptOf(assetId, [word("hi", 0, 0.5)]); } };
    return { calls, h: setupTranscript({ transcriber }) };
  }

  it("transcribes, stores, and reuses the stored transcript unless forced", async () => {
    // #given
    const { calls, h } = withTranscriber();
    // #when
    const first = await h.data<{ cached: boolean; words: number }>("transcribe_asset", { assetId: "a2" });
    const second = await h.data<{ cached: boolean }>("transcribe_asset", { assetId: "a2" });
    await h.data("transcribe_asset", { assetId: "a2", force: true });
    // #then
    expect(first).toMatchObject({ cached: false, words: 1 });
    expect(second.cached).toBe(true);
    expect(calls).toEqual(["a2", "a2"]);
    expect(await h.store.get("a2")).toBeDefined();
  });

  it("rejects unknown and silent assets and wraps recognizer failures", async () => {
    const failing: Transcriber = { transcribe: async () => { throw new Error("model not loaded"); } };
    const h = setupTranscript({ transcriber: failing });
    expect((await h.failure("transcribe_asset", { assetId: "missing" })).hint).toMatch(/list_assets/);
    expect((await h.failure("transcribe_asset", { assetId: "photo" })).error).toMatch(/no audio/);
    expect((await h.failure("transcribe_asset", { assetId: "a2" })).error).toMatch(/model not loaded/);
  });
});

describe("transcript data shape", () => {
  it("keeps TALK_WORDS sorted so the fixtures are valid", () => {
    const starts = TALK_WORDS.map((w) => w.startSeconds);
    expect(starts).toEqual([...starts].sort((a, b) => a - b));
  });
});
