import { describe, expect, it } from "vitest";
import { buildTemporalIndex } from "#/engine/temporal";
import {
  DEFAULT_MAX_FRAMES, frameSpans, isUsableEmbeddings, mergeHitsIntoMoments, normalize, planFrameTimes, rankByText, scoreFrames, sortVisualMoments,
} from "#/engine/visual";
import { A1_CUTS, A1_FRAMES, makeEmbeddings, vectorOf } from "./visual-harness";
import { makeAnalysis, standardIndex } from "./temporal-harness";

const a1 = () => makeEmbeddings({ frames: A1_FRAMES, cuts: A1_CUTS });

describe("normalize", () => {
  it("returns a unit vector and leaves the zero vector alone", () => {
    expect(Array.from(normalize(Float32Array.from([3, 4])))).toEqual([0.6000000238418579, 0.800000011920929]);
    expect(Array.from(normalize(new Float32Array(3)))).toEqual([0, 0, 0]);
  });
});

describe("rankByText", () => {
  it("orders frames by cosine similarity, best first", () => {
    const ranked = rankByText(a1(), vectorOf({ dog: 1 }));
    expect(ranked.map((f) => f.timeSeconds)).toEqual([3, 5, 1, 7, 9]);
    expect(ranked[0]?.score).toBeCloseTo(1, 5);
    expect(ranked[1]?.score).toBeCloseTo(1 / Math.sqrt(1.0625), 5);
  });

  it("scores a text embedding of any length scale the same (it normalises defensively)", () => {
    const unit = scoreFrames(a1(), vectorOf({ dog: 1 }));
    const scaled = scoreFrames(a1(), vectorOf({ dog: 1 }).map((v) => v * 37));
    scaled.forEach((s, i) => expect(s).toBeCloseTo(unit[i] as number, 5));
  });

  it("applies minScore, limit and withinOfBest", () => {
    const text = vectorOf({ dog: 1 });
    expect(rankByText(a1(), text, { minScore: 0.5 }).map((f) => f.timeSeconds)).toEqual([3, 5]);
    expect(rankByText(a1(), text, { limit: 1 }).map((f) => f.timeSeconds)).toEqual([3]);
    expect(rankByText(a1(), text, { withinOfBest: 0.01 }).map((f) => f.timeSeconds)).toEqual([3]);
    expect(rankByText(a1(), text, { limit: 0 })).toEqual([]);
  });

  it("breaks score ties by time so output is deterministic", () => {
    const ranked = rankByText(a1(), vectorOf({ sky: 1 }));
    expect(ranked.slice(0, 2).map((f) => f.timeSeconds)).toEqual([1, 9]);
  });

  it("returns nothing for an all-zero query and rejects a text embedding from another model", () => {
    expect(rankByText(a1(), new Float32Array(4), { minScore: 0.1 })).toEqual([]);
    expect(() => rankByText(a1(), new Float32Array(512))).toThrow(/different models/);
  });
});

describe("frameSpans", () => {
  it("covers halfway to each neighbour, clipped to the asset and to the shot of the frame", () => {
    const spans = frameSpans({ times: [1, 3, 5, 7, 9], durationSeconds: 10, cuts: A1_CUTS });
    expect(spans).toEqual([
      { startSeconds: 0, endSeconds: 2 }, { startSeconds: 2, endSeconds: 4 }, { startSeconds: 4, endSeconds: 6 },
      { startSeconds: 6, endSeconds: 8 }, { startSeconds: 8, endSeconds: 10 },
    ]);
  });

  it("never crosses a scene cut that falls between two frames", () => {
    const spans = frameSpans({ times: [1, 3], durationSeconds: 10, cuts: [1.5] });
    expect(spans[0]).toEqual({ startSeconds: 0, endSeconds: 1.5 });
    expect(spans[1]).toEqual({ startSeconds: 2, endSeconds: 10 });
  });

  it("gives a single frame the whole asset", () => {
    expect(frameSpans({ times: [4], durationSeconds: 8, cuts: [] })).toEqual([{ startSeconds: 0, endSeconds: 8 }]);
  });
});

describe("mergeHitsIntoMoments", () => {
  const spans = frameSpans({ times: [1, 3, 5, 7, 9], durationSeconds: 10, cuts: A1_CUTS });
  const hit = (index: number, score: number) => ({ index, timeSeconds: (spans[index]?.startSeconds ?? 0) + 1, score });

  it("merges touching hits into one moment with the best score and a frame count", () => {
    expect(mergeHitsIntoMoments({ spans, hits: [hit(2, 0.3), hit(1, 0.4)] })).toEqual([{ startSeconds: 2, endSeconds: 6, score: 0.4, frames: 2 }]);
  });

  it("keeps separated hits apart unless the gap is bridged", () => {
    const hits = [hit(1, 0.3), hit(3, 0.3)];
    expect(mergeHitsIntoMoments({ spans, hits })).toHaveLength(2);
    expect(mergeHitsIntoMoments({ spans, hits, mergeGapSeconds: 2 })).toEqual([{ startSeconds: 2, endSeconds: 8, score: 0.3, frames: 2 }]);
  });

  it("returns nothing without hits and ignores hits that point at no span", () => {
    expect(mergeHitsIntoMoments({ spans, hits: [] })).toEqual([]);
    expect(mergeHitsIntoMoments({ spans, hits: [{ index: 99, timeSeconds: 0, score: 1 }] })).toEqual([]);
  });

  it("sorts by score or by time", () => {
    const moments = [{ startSeconds: 0, endSeconds: 1, score: 0.2, frames: 1 }, { startSeconds: 5, endSeconds: 6, score: 0.9, frames: 1 }];
    expect(sortVisualMoments(moments, "relevance").map((m) => m.startSeconds)).toEqual([5, 0]);
    expect(sortVisualMoments(moments, "time").map((m) => m.startSeconds)).toEqual([0, 5]);
  });
});

describe("planFrameTimes", () => {
  it("samples every shot midpoint plus a frame every interval, without near-duplicates", () => {
    const times = planFrameTimes({ durationSeconds: 10, cutTimes: [4, 8], intervalSeconds: 2 });
    expect(times).toEqual([1, 2, 3, 5, 6, 7, 9]);
    expect(times).toContain(2);
  });

  it("includes the midpoint of a shot shorter than the interval", () => {
    expect(planFrameTimes({ durationSeconds: 10, cutTimes: [5, 5.4], intervalSeconds: 4 })).toContain(5.2);
  });

  it("samples a grid when nothing is known about shots, and nothing for an empty video", () => {
    expect(planFrameTimes({ durationSeconds: 5, cutTimes: [], intervalSeconds: 2 })).toEqual([1, 2.5, 3]);
    expect(planFrameTimes({ durationSeconds: 0, cutTimes: [] })).toEqual([]);
  });

  it("caps the total, keeping shot midpoints before grid frames, ascending and unique", () => {
    const cuts = [10, 20, 30];
    const times = planFrameTimes({ durationSeconds: 40, cutTimes: cuts, intervalSeconds: 1, maxFrames: 10 });
    expect(times).toHaveLength(10);
    for (const mid of [5, 15, 25, 35]) expect(times).toContain(mid);
    expect([...times].sort((a, b) => a - b)).toEqual(times);
    expect(new Set(times).size).toBe(times.length);
  });

  it("thins shot midpoints themselves when there are more shots than the cap", () => {
    const cuts = Array.from({ length: 50 }, (_, i) => i + 1);
    expect(planFrameTimes({ durationSeconds: 51, cutTimes: cuts, maxFrames: 5 })).toHaveLength(5);
  });

  it("never exceeds the default cap on long video", () => {
    expect(planFrameTimes({ durationSeconds: 7200, cutTimes: [] }).length).toBeLessThanOrEqual(DEFAULT_MAX_FRAMES);
  });

  it("ignores cuts outside the asset", () => {
    expect(planFrameTimes({ durationSeconds: 4, cutTimes: [-1, 0, 4, 9], intervalSeconds: 8 })).toEqual([2]);
  });
});

describe("isUsableEmbeddings", () => {
  it("accepts matching model and version and rejects anything else", () => {
    const e = a1();
    expect(isUsableEmbeddings(e, e.model)).toBe(true);
    expect(isUsableEmbeddings(e, "other/model")).toBe(false);
    expect(isUsableEmbeddings({ ...e, version: 99 as never }, e.model)).toBe(false);
    expect(isUsableEmbeddings({ ...e, vectors: new Float32Array(3) }, e.model)).toBe(false);
  });
});

describe("buildTemporalIndex with visual embeddings", () => {
  it("is unchanged without them: no visual track and no visual source flag", () => {
    const index = standardIndex();
    expect(index.tracks.visual).toBeUndefined();
    expect(index.sources.visual).toBeUndefined();
    expect(index.sources).toEqual({ analysis: true, transcript: true, audio: true });
  });

  it("adds one event per sampled frame as tracks.visual", () => {
    const index = buildTemporalIndex({ assetId: "a1", duration: 10, analysis: makeAnalysis(), visual: { embeddings: a1() } });
    expect(index.sources.visual).toBe(true);
    expect(index.tracks.visual?.map((e) => [e.startSeconds, e.endSeconds])).toEqual([[0, 2], [2, 4], [4, 6], [6, 8], [8, 10]]);
    expect(index.tracks.speech).toEqual([]);
  });

  it("with a query, adds labelled, scored matching stretches", () => {
    const query = { label: "dog", embedding: vectorOf({ dog: 1 }), minScore: 0.5 };
    const index = buildTemporalIndex({ assetId: "a1", duration: 10, visual: { embeddings: a1(), query } });
    expect(index.tracks.visual).toEqual([{ startSeconds: 2, endSeconds: 6, label: "dog", score: expect.closeTo(1, 5) }]);
  });
});
