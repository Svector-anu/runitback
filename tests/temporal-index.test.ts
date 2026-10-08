import { describe, expect, it } from "vitest";
import {
  MAX_DESCRIPTION_CHARS, buildTemporalIndex, describeIndex, findMoments, momentsToTimelineRanges, rankMoments, summarizeIndex,
  type Moment, type TemporalIndex,
} from "#/engine/temporal";
import { TALK_WORDS, makeAnalysis, spoken, standardIndex, transcriptOf } from "./temporal-harness";

const round = (n: number | null, digits = 2): number | null => (n === null ? null : Math.round(n * 10 ** digits) / 10 ** digits);
const spans = (moments: Moment[]): Array<[number, number]> => moments.map((m) => [Math.round(m.startSeconds * 100) / 100, Math.round(m.endSeconds * 100) / 100]);

describe("buildTemporalIndex", () => {
  it("makes shots from scene cuts with per-shot loudness, silence and speech stats", () => {
    // #given #when
    const index = standardIndex();
    // #then
    expect(index.shots.map((s) => [s.startSeconds, s.endSeconds])).toEqual([[0, 3], [3, 7], [7, 10]]);
    expect(index.shots.map((s) => round(s.loudnessMeanDb, 1))).toEqual([-30, -11.2, -20]);
    expect(index.shots.map((s) => s.loudnessPeakDb)).toEqual([-30, -10, -20]);
    expect(index.shots.map((s) => round(s.silenceRatio))).toEqual([0, 0.25, 0]);
    expect(index.shots.map((s) => s.speechWordCount)).toEqual([4, 10, 3]);
    expect(round(index.shots[1]?.wordsPerSecond ?? 0)).toBe(2.5);
    expect(index.shots[1]?.motion).toBe("high");
  });

  it("is one shot when there are no scene cuts, and ignores cuts at the edges or on top of each other", () => {
    expect(buildTemporalIndex({ assetId: "x", duration: 8, analysis: makeAnalysis({ cuts: [] }) }).shots).toHaveLength(1);
    const noisy = buildTemporalIndex({ assetId: "x", duration: 8, analysis: makeAnalysis({ duration: 8, cuts: [0, 4, 4.01, 8, 9] }) });
    expect(noisy.shots.map((s) => [s.startSeconds, s.endSeconds])).toEqual([[0, 4], [4, 8]]);
  });

  it("groups sentences with word index ranges and the shot they sit in", () => {
    const { speech } = standardIndex().tracks;
    expect(speech.map((s) => [s.startWord, s.endWord, s.shotIndex, s.text])).toEqual([
      [0, 3, 0, "Welcome to the show."], [4, 9, 1, "Let us talk about the budget."], [10, 13, 1, "The budget is tight."], [14, 16, 2, "Thanks for watching."],
    ]);
  });

  it("carries silences, onsets and a beat grid", () => {
    const index = standardIndex();
    expect(index.tracks.silence).toEqual([{ startSeconds: 4.5, endSeconds: 5.5, meanDb: -90 }]);
    expect(index.tracks.onset).toHaveLength(4);
    expect(index.rhythm?.onsetCount).toBe(4);
    expect(index.rhythm?.strongOnsets).toEqual([0.5, 1, 1.5, 2]);
    expect(index.rhythm?.beatGrid).toMatchObject({ bpm: 120, periodSeconds: 0.5, confidence: 0.9 });
    expect(index.rhythm?.beatGrid?.firstBeatSeconds).toBeGreaterThanOrEqual(0);
    expect(index.rhythm?.beatGrid?.firstBeatSeconds).toBeLessThan(0.5);
  });

  it("omits the beat grid when the tempo is not trusted", () => {
    const index = buildTemporalIndex({ assetId: "a1", duration: 10, analysis: makeAnalysis({ tempo: { bpm: 120, confidence: 0.05 } }) });
    expect(index.rhythm?.beatGrid).toBeUndefined();
  });

  it("works with only a transcript: one shot, no loudness, and says what is missing", () => {
    const index = buildTemporalIndex({ assetId: "a1", duration: 10, transcript: transcriptOf("a1", TALK_WORDS) });
    expect(index.sources).toEqual({ analysis: false, transcript: true, audio: true });
    expect(index.shots).toHaveLength(1);
    expect(index.shots[0]).toMatchObject({ loudnessMeanDb: null, silenceRatio: null, speechWordCount: 17 });
    expect(describeIndex(index)).toContain("No audio/video analysis");
  });

  it("works with only an analysis: no speech, and says what is missing", () => {
    const index = buildTemporalIndex({ assetId: "a1", duration: 10, analysis: makeAnalysis() });
    expect(index.sources.transcript).toBe(false);
    expect(index.tracks.speech).toEqual([]);
    expect(describeIndex(index)).toContain("No transcript");
  });

  it("reports no loudness for an asset without audio", () => {
    const index = buildTemporalIndex({ assetId: "a1", duration: 10, analysis: makeAnalysis({ hasAudio: false }) });
    expect(index.shots.every((s) => s.loudnessMeanDb === null && s.silenceRatio === null)).toBe(true);
    expect(index.sources.audio).toBe(false);
  });

  it("accepts extra tracks without changing how consumers read the core ones", () => {
    const index: TemporalIndex = standardIndex();
    index.tracks.face = [{ startSeconds: 1, endSeconds: 2, label: "host", score: 0.9 }];
    expect(findMoments(index, { text: "budget" })).toHaveLength(2);
    expect(describeIndex(index)).toContain("Other tracks: face (1)");
    expect(summarizeIndex(index).otherTracks).toEqual({ face: 1 });
  });
});

describe("findMoments", () => {
  const index = standardIndex();

  it("returns whole shots when nothing narrows it", () => {
    const moments = findMoments(index);
    expect(spans(moments)).toEqual([[0, 3], [3, 7], [7, 10]]);
    expect(moments.map((m) => m.reason)).toEqual(["shot 0", "shot 1", "shot 2"]);
    expect(moments.map((m) => round(m.loudnessDb, 1))).toEqual([-30, -11.2, -20]);
  });

  it("text: the sentences that contain the phrase, with their words and shot", () => {
    const moments = findMoments(index, { text: "budget" });
    expect(moments.map((m) => m.text)).toEqual(["Let us talk about the budget.", "The budget is tight."]);
    expect(moments.map((m) => m.shotIndex)).toEqual([1, 1]);
    expect(moments[0]?.reason).toBe('says "budget"');
  });

  it("text: ignores case and punctuation and matches multi-word phrases", () => {
    expect(findMoments(index, { text: "THE BUDGET, is" }).map((m) => m.text)).toEqual(["The budget is tight."]);
    expect(findMoments(index, { text: "nothing like this" })).toEqual([]);
  });

  it("text: ranks sentences with more matches first, then by time", () => {
    const words = [...spoken("A budget note.", 0, 1), ...spoken("Budget and budget again.", 2, 4), ...spoken("One more budget.", 5, 6)];
    const doubled = buildTemporalIndex({ assetId: "a1", duration: 8, transcript: transcriptOf("a1", words) });
    const moments = findMoments(doubled, { text: "budget" });
    expect(moments.map((m) => [m.text, m.matches])).toEqual([["Budget and budget again.", 2], ["A budget note.", 1], ["One more budget.", 1]]);
    expect(moments[0]?.reason).toBe('says "budget" (2x)');
    expect(findMoments(doubled, { text: "budget", sort: "time" }).map((m) => m.matches)).toEqual([1, 2, 1]);
  });

  it("text: a phrase that straddles two sentences yields one moment covering both", () => {
    const words = [...spoken("We ended on budget.", 0, 1), ...spoken("Cuts follow.", 1.1, 2)];
    const straddle = buildTemporalIndex({ assetId: "a1", duration: 4, transcript: transcriptOf("a1", words) });
    const moments = findMoments(straddle, { text: "budget cuts" });
    expect(moments).toHaveLength(1);
    expect(moments[0]?.text).toBe("We ended on budget. Cuts follow.");
  });

  it("shot: restricts and clips to that shot", () => {
    expect(spans(findMoments(index, { shot: 2 }))).toEqual([[7, 10]]);
    expect(spans(findMoments(index, { shot: 1, text: "budget" }))).toEqual([[3.2, 4.36], [5.6, 6.76]]);
    expect(findMoments(index, { shot: 0, text: "budget" })).toEqual([]);
    expect(findMoments(index, { shot: 9 })).toEqual([]);
  });

  it("minLoudnessDb / maxLoudnessDb filter by the mean level of the moment", () => {
    expect(findMoments(index, { minLoudnessDb: -15 }).map((m) => m.shotIndex)).toEqual([1]);
    expect(findMoments(index, { maxLoudnessDb: -15 }).map((m) => m.shotIndex)).toEqual([0, 2]);
    expect(findMoments(index, { minLoudnessDb: -25, maxLoudnessDb: -15 }).map((m) => m.shotIndex)).toEqual([2]);
    expect(findMoments(index, { minLoudnessDb: 0 })).toEqual([]);
  });

  it("loudness filters exclude moments whose level is unknown", () => {
    const quiet = buildTemporalIndex({ assetId: "a1", duration: 10, transcript: transcriptOf("a1", TALK_WORDS) });
    expect(findMoments(quiet, { minLoudnessDb: -100 })).toEqual([]);
    expect(findMoments(quiet, { text: "budget" })).toHaveLength(2);
  });

  it("silent:true returns the silences; silent:false drops the mostly silent ones", () => {
    const silences = findMoments(index, { silent: true });
    expect(spans(silences)).toEqual([[4.5, 5.5]]);
    expect(silences[0]?.reason).toBe("silence of 1s");
    expect(silences[0]?.loudnessDb).toBeCloseTo(-90, 5);
    expect(findMoments(index, { silent: false }).map((m) => m.shotIndex)).toEqual([0, 1, 2]);
    expect(findMoments(index, { silent: false, sourceRange: { startSeconds: 4.5, endSeconds: 5.5 } })).toEqual([]);
  });

  it("speaking:true returns sentences; speaking:false keeps only the shots that are mostly quiet", () => {
    expect(findMoments(index, { speaking: true }).map((m) => m.text)).toEqual(["Welcome to the show.", "Let us talk about the budget.", "The budget is tight.", "Thanks for watching."]);
    expect(findMoments(index, { speaking: false })).toEqual([]);
    const sparse = buildTemporalIndex({ assetId: "a1", duration: 10, analysis: makeAnalysis(), transcript: transcriptOf("a1", spoken("Hi there.", 0, 1)) });
    expect(findMoments(sparse, { speaking: false }).map((m) => m.shotIndex)).toEqual([0, 1, 2]);
  });

  it("speaking:true falls back to speech-like audio ranges when there is no transcript", () => {
    const analysis = { ...makeAnalysis(), speechLikeRanges: [{ start: 1, end: 2 }] };
    const energyOnly = buildTemporalIndex({ assetId: "a1", duration: 10, analysis });
    const moments = findMoments(energyOnly, { speaking: true });
    expect(spans(moments)).toEqual([[1, 2]]);
    expect(moments[0]?.reason).toBe("speech-like audio");
  });

  it("sourceRange clips moments to the range and drops those outside", () => {
    expect(spans(findMoments(index, { sourceRange: { startSeconds: 2, endSeconds: 5 } }))).toEqual([[2, 3], [3, 5]]);
    expect(spans(findMoments(index, { text: "budget", sourceRange: { startSeconds: 4, endSeconds: 6 } }))).toEqual([[4, 4.36], [5.6, 6]]);
    expect(findMoments(index, { sourceRange: { startSeconds: 20, endSeconds: 30 } })).toEqual([]);
  });

  it("combines filters: text + loudness + shot + sourceRange all must hold", () => {
    expect(findMoments(index, { text: "budget", minLoudnessDb: -12 }).map((m) => m.text)).toEqual(["Let us talk about the budget.", "The budget is tight."]);
    expect(findMoments(index, { text: "budget", minLoudnessDb: -5 })).toEqual([]);
    expect(findMoments(index, { text: "show", maxLoudnessDb: -20 }).map((m) => m.shotIndex)).toEqual([0]);
    expect(findMoments(index, { text: "budget", speaking: true, silent: false, shot: 1, sourceRange: { startSeconds: 5, endSeconds: 10 } }).map((m) => m.text)).toEqual(["The budget is tight."]);
    expect(findMoments(index, { text: "budget", silent: true })).toEqual([]);
  });

  it("sorts by loudest, quietest, longest and time, ties by time", () => {
    expect(findMoments(index, { sort: "loudest" }).map((m) => m.shotIndex)).toEqual([1, 2, 0]);
    expect(findMoments(index, { sort: "quietest" }).map((m) => m.shotIndex)).toEqual([0, 2, 1]);
    expect(findMoments(index, { sort: "longest" }).map((m) => m.shotIndex)).toEqual([1, 0, 2]);
    expect(findMoments(index, { sort: "time" }).map((m) => m.shotIndex)).toEqual([0, 1, 2]);
    const flat = buildTemporalIndex({ assetId: "a1", duration: 9, analysis: makeAnalysis({ duration: 9, cuts: [3, 6], levels: [-20, -20, -20], silences: [] }) });
    expect(findMoments(flat, { sort: "loudest" }).map((m) => m.shotIndex)).toEqual([0, 1, 2]);
  });

  it("puts moments with unknown loudness last when sorting by loudness", () => {
    const moments: Moment[] = [
      { startSeconds: 0, endSeconds: 1, shotIndex: 0, loudnessDb: null, reason: "a", matches: 0 },
      { startSeconds: 1, endSeconds: 2, shotIndex: 0, loudnessDb: -40, reason: "b", matches: 0 },
    ];
    expect(rankMoments(moments, "loudest").map((m) => m.reason)).toEqual(["b", "a"]);
    expect(rankMoments(moments, "quietest").map((m) => m.reason)).toEqual(["b", "a"]);
  });

  it("limit keeps the best-ranked moments; 0 returns none", () => {
    expect(findMoments(index, { sort: "loudest", limit: 1 }).map((m) => m.shotIndex)).toEqual([1]);
    expect(findMoments(index, { limit: 0 })).toEqual([]);
    expect(findMoments(index, {})).toHaveLength(3);
  });

  it("is deterministic: unordered inputs and repeated calls give identical results", () => {
    const shuffled = makeAnalysis({ cuts: [7, 3], silences: [SILENCE_B, SILENCE_A] });
    const a = buildTemporalIndex({ assetId: "a1", duration: 10, analysis: makeAnalysis({ silences: [SILENCE_A, SILENCE_B] }), transcript: transcriptOf("a1", TALK_WORDS) });
    const b = buildTemporalIndex({ assetId: "a1", duration: 10, analysis: shuffled, transcript: transcriptOf("a1", TALK_WORDS) });
    for (const query of [{}, { silent: true }, { text: "the" }, { sort: "loudest" as const }]) {
      expect(findMoments(b, query).map((m) => [m.startSeconds, m.endSeconds])).toEqual(findMoments(a, query).map((m) => [m.startSeconds, m.endSeconds]));
      expect(findMoments(a, query)).toEqual(findMoments(a, query));
    }
  });

  it("breaks ties across assets by asset id", () => {
    const tied = [
      { assetId: "b", startSeconds: 0, endSeconds: 1, shotIndex: 0, loudnessDb: -20, reason: "x", matches: 1 },
      { assetId: "a", startSeconds: 5, endSeconds: 6, shotIndex: 0, loudnessDb: -20, reason: "x", matches: 1 },
    ];
    expect(rankMoments(tied, "relevance").map((m) => m.assetId)).toEqual(["a", "b"]);
  });
});

const SILENCE_A = { start: 1, end: 1.5 };
const SILENCE_B = { start: 8, end: 9 };

describe("describeIndex", () => {
  it("summarises shots, speech, silences and rhythm in a few lines", () => {
    const text = describeIndex(standardIndex());
    expect(text).toContain("Footage a1: 10s, 3 shot(s). Indexed from: analysis + transcript.");
    expect(text).toContain("#1 3s-7s: mean -11.2dB, peak -10dB, silent 25%, 10 words (2.5/s), motion high");
    expect(text).toContain('[4-9] 3.2s-4.36s (shot 1) "Let us talk about the budget."');
    expect(text).toContain("Silences: 1, 1s in total.");
    expect(text).toContain("120 bpm");
    expect(text.length).toBeLessThan(MAX_DESCRIPTION_CHARS);
  });

  it("stays within the size bound however large the index is", () => {
    const cuts = Array.from({ length: 400 }, (_, i) => (i + 1) * 2);
    const words = Array.from({ length: 300 }, (_, i) => spoken(`Sentence number ${i} says a rather long thing about the budget and many other topics entirely.`, i * 2.5, i * 2.5 + 2)).flat();
    const silences = Array.from({ length: 200 }, (_, i) => ({ start: i * 4 + 0.5, end: i * 4 + 1.2 }));
    const analysis = makeAnalysis({ duration: 810, cuts, silences, levels: [-20] });
    const huge = buildTemporalIndex({ assetId: "big", duration: 810, analysis, transcript: transcriptOf("big", words) });
    const text = describeIndex(huge);
    expect(huge.shots.length).toBeGreaterThan(300);
    expect(text.length).toBeLessThanOrEqual(MAX_DESCRIPTION_CHARS);
    expect(text).toContain("more shots (use find_moments)");
    expect(text).toContain("more sentences (use find_moments)");
    expect(text.split("\n").length).toBeLessThan(45);
    const summary = JSON.stringify(summarizeIndex(huge));
    expect(summary.length).toBeLessThan(20_000);
  });

  it("truncates a description that is still too long and says so", () => {
    const long = buildTemporalIndex({ assetId: "a".repeat(5000), duration: 10 });
    const text = describeIndex(long);
    expect(text.length).toBeLessThanOrEqual(MAX_DESCRIPTION_CHARS);
    expect(text).toContain("(truncated)");
  });
});

describe("momentsToTimelineRanges", () => {
  const placement = { startSeconds: 10, durationSeconds: 4, trimStartSeconds: 2, rate: 2 };
  const range = (start: number, end: number) => ({ startSeconds: start, endSeconds: end });

  it("maps source moments through trim, speed and start", () => {
    // clip plays source [2,10) over timeline [10,14)
    expect(momentsToTimelineRanges({ moments: [range(3, 4), range(4, 8)], placement })).toEqual([
      { momentIndex: 0, startSeconds: 10.5, endSeconds: 11 },
      { momentIndex: 1, startSeconds: 11, endSeconds: 13 },
    ]);
  });

  it("clips moments that straddle the played part and drops those outside it", () => {
    expect(momentsToTimelineRanges({ moments: [range(0, 1), range(1, 3), range(9, 12), range(11, 12)], placement })).toEqual([
      { momentIndex: 1, startSeconds: 10, endSeconds: 10.5 },
      { momentIndex: 2, startSeconds: 13.5, endSeconds: 14 },
    ]);
  });

  it("handles slow motion (rate below 1) and ignores degenerate placements", () => {
    expect(momentsToTimelineRanges({ moments: [range(1, 2)], placement: { startSeconds: 0, durationSeconds: 8, trimStartSeconds: 0, rate: 0.5 } })).toEqual([{ momentIndex: 0, startSeconds: 2, endSeconds: 4 }]);
    expect(momentsToTimelineRanges({ moments: [range(1, 2)], placement: { ...placement, rate: 0 } })).toEqual([]);
    expect(momentsToTimelineRanges({ moments: [range(1, 2)], placement: { ...placement, durationSeconds: 0 } })).toEqual([]);
  });
});
