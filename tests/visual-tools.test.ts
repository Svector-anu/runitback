import { describe, expect, it } from "vitest";
import { createAgentTools, createVisualTools } from "#/engine/agent";
import type { InsertedData } from "./agent-harness";
import { assertEditorHealthy, snapshotForUndo } from "./invariants-harness";
import { A1_CUTS, A1_FRAMES, CONCEPTS, FAKE_MODEL, makeEmbeddings, setupVisual, type VisualHarness } from "./visual-harness";

interface Found {
  assetId: string; startSeconds: number; endSeconds: number; score: number; frames: number;
  timeline?: Array<{ elementId: string; startSeconds: number; endSeconds: number }>;
}
interface FindData { moments: Found[]; truncated: boolean; skipped: Array<{ assetId: string; reason: string }>; unit: string; bestScore: number; query: string }
interface CutData { clips: Array<{ elementId: string; assetId: string; sourceStart: number; sourceEnd: number; start: number; end: number }> }

const find = (h: VisualHarness, args: Record<string, unknown>): Promise<FindData> => h.data<FindData>("find_visual_moments", args);
const span = (m: Found): [number, number] => [m.startSeconds, m.endSeconds];

describe("registry", () => {
  it("is opt-in: the default registry has no visual tools", () => {
    expect([...createAgentTools().keys()].filter((n) => /visual/.test(n))).toEqual([]);
  });

  it("registers index_visuals only when an indexer is supplied, and flags both read-only", () => {
    expect([...setupVisual().tools.keys()].filter((n) => /visual/.test(n))).toEqual(["find_visual_moments"]);
    const { tools } = setupVisual({ withIndexer: true });
    expect(["index_visuals", "find_visual_moments"].map((n) => tools.get(n)?.readOnly)).toEqual([true, true]);
  });
});

describe("find_visual_moments", () => {
  it("finds the stretch that looks like the query, in source seconds, merging touching matching frames", async () => {
    const h = setupVisual();
    const data = await find(h, { assetId: "a1", query: "a dog" });
    expect(data.unit).toBe("source seconds");
    expect(data.moments.map(span)).toEqual([[2, 6]]);
    expect(data.moments[0]).toMatchObject({ assetId: "a1", frames: 2 });
    expect(data.moments[0]?.score).toBeCloseTo(1, 3);
    expect(data.moments[0]?.timeline).toBeUndefined();
  });

  it("keeps separate stretches separate and orders them by score, or by time on request", async () => {
    const h = setupVisual({ embeddings: [makeEmbeddings({
      cuts: A1_CUTS,
      frames: [{ time: 1, mix: { dog: 1, sky: 0.2 } }, { time: 3, mix: { sky: 1 } }, { time: 5, mix: { sky: 1 } }, { time: 7, mix: { dog: 1 } }, { time: 9, mix: { dog: 1, sky: 0.2 } }],
    })] });
    const byScore = await find(h, { assetId: "a1", query: "dog" });
    expect(byScore.moments.map(span)).toEqual([[6, 10], [0, 2]]);
    const byTime = await find(h, { assetId: "a1", query: "dog", sort: "time" });
    expect(byTime.moments.map(span)).toEqual([[0, 2], [6, 10]]);
  });

  it("drops the haze of weak frames: only frames near the best score count, and nothing below minScore", async () => {
    const h = setupVisual();
    const data = await find(h, { assetId: "a1", query: "whiteboard" });
    expect(data.moments.map(span)).toEqual([[4, 6]]);
    const strict = await h.call("find_visual_moments", { assetId: "a1", query: "whiteboard", minScore: 0.9 });
    expect(strict.ok && strict.summary).toMatch(/No frame looks like "whiteboard"/);
  });

  it("keeps only frames near the best score: a clearly weaker frame above minScore is not a second match", async () => {
    const h = setupVisual({ embeddings: [makeEmbeddings({ cuts: A1_CUTS, frames: [{ time: 3, mix: { dog: 1 } }, { time: 7, mix: { dog: 1, whiteboard: 0.8 } }] })] });
    expect((await find(h, { assetId: "a1", query: "dog" })).moments.map(span)).toEqual([[0, 4]]);
    expect((await find(h, { assetId: "a1", query: "dog", minScore: 0.9 })).moments.map(span)).toEqual([[0, 4]]);
  });

  it("reports no match, with the best similarity, instead of returning the least-bad frame", async () => {
    const h = setupVisual();
    const result = await h.call("find_visual_moments", { assetId: "a1", query: "a submarine" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.summary).toMatch(/best similarity was 0/);
    expect((result.data as FindData).moments).toEqual([]);
  });

  it("maps moments onto the timeline through the clip's start, trim and speed", async () => {
    const h = setupVisual();
    await h.data("insert_media", { assetId: "a3" });
    const clip = await h.data<InsertedData>("insert_media", { assetId: "a1" });
    await h.data("set_speed", { elementId: clip.elementId, speed: 2 });
    const data = await find(h, { assetId: "a1", query: "dog" });
    expect(data.moments[0]?.timeline).toEqual([{ elementId: clip.elementId, startSeconds: 6 + 2 / 2, endSeconds: 6 + 6 / 2 }]);
  });

  it("omits timeline ranges for the part of a moment a trimmed clip does not play", async () => {
    const h = setupVisual();
    const clip = await h.data<InsertedData>("insert_media", { assetId: "a1" });
    await h.data("trim", { elementId: clip.elementId, start: 4 });
    const data = await find(h, { assetId: "a1", query: "dog" });
    expect(data.moments[0]?.timeline?.[0]).toMatchObject({ elementId: clip.elementId });
    expect(data.moments[0]?.timeline?.[0]?.endSeconds).toBeLessThanOrEqual(2.001);
  });

  it("searches every indexed video with allAssets and lists the ones it could not search", async () => {
    const h = setupVisual({ embeddings: [
      makeEmbeddings({ assetId: "a1", cuts: A1_CUTS, frames: A1_FRAMES }),
      makeEmbeddings({ assetId: "a2", durationSeconds: 8, frames: [{ time: 2, mix: { dog: 1 } }, { time: 6, mix: { sky: 1 } }] }),
      makeEmbeddings({ assetId: "a3", durationSeconds: 6, model: "other/model", frames: [{ time: 3, mix: { dog: 1 } }] }),
    ] });
    const data = await find(h, { allAssets: true, query: "dog", sort: "time" });
    expect(data.moments.map((m) => [m.assetId, ...span(m)])).toEqual([["a2", 0, 4], ["a1", 2, 6]]);
    expect(data.skipped).toEqual([{ assetId: "a3", reason: "stale-index" }]);
  });

  it("limits results and says when more exist", async () => {
    const frames = Array.from({ length: 8 }, (_, i) => ({ time: i * 2 + 1, mix: i % 2 === 0 ? { dog: 1 } : { sky: 1 } }));
    const h = setupVisual({ embeddings: [makeEmbeddings({ durationSeconds: 16, frames })] });
    const data = await find(h, { assetId: "a1", query: "dog", limit: 2 });
    expect(data.moments).toHaveLength(2);
    expect(data.truncated).toBe(true);
    expect((await find(h, { assetId: "a1", query: "dog", limit: 4 })).truncated).toBe(false);
  });

  it("fails with hints for bad input, unknown or non-video assets, and missing or outdated indexes", async () => {
    const h = setupVisual();
    expect((await h.failure("find_visual_moments", { assetId: "a1", query: "  " })).error).toContain("query is empty");
    expect((await h.failure("find_visual_moments", { query: "dog" })).error).toContain("exactly one of");
    expect((await h.failure("find_visual_moments", { query: "dog", assetId: "a1", allAssets: true })).error).toContain("exactly one of");
    expect((await h.failure("find_visual_moments", { query: "x".repeat(300), assetId: "a1" })).error).toContain("limit");
    expect((await h.failure("find_visual_moments", { query: "dog", assetId: "nope" })).hint).toContain("list_assets");
    expect((await h.failure("find_visual_moments", { query: "dog", assetId: "photo" })).error).toContain("image");
    expect((await h.failure("find_visual_moments", { query: "dog", assetId: "music" })).error).toContain("only video");
    const missing = await h.failure("find_visual_moments", { query: "dog", assetId: "a2" });
    expect(missing.error).toContain("no visual index");
    expect(missing.hint).toContain("Ask the user to press Index visuals");
    expect((await h.failure("find_visual_moments", { query: "dog", allAssets: true, limit: 0 })).error).toBeTruthy();
    const stale = setupVisual({ embeddings: [makeEmbeddings({ model: "old/model", frames: A1_FRAMES })], withIndexer: true });
    const outdated = await stale.failure("find_visual_moments", { query: "dog", assetId: "a1" });
    expect(outdated.error).toContain("different model");
    expect(outdated.hint).toContain("force:true");
  });

  it("fails when nothing is indexed at all, and when the query embedding cannot be computed", async () => {
    const empty = setupVisual({ embeddings: [] });
    expect((await empty.failure("find_visual_moments", { query: "dog", allAssets: true })).error).toContain("None of the videos");
    const h = setupVisual();
    const tools = new Map(createVisualTools({ store: h.store, searcher: { model: FAKE_MODEL, embedText: async () => { throw new Error("worker crashed"); } } }).map((t) => [t.name, t]));
    const result = await tools.get("find_visual_moments")?.run({ query: "dog", assetId: "a1" }, { editor: h.editor, nowMs: () => 0 });
    expect(result?.ok).toBe(false);
    if (result && !result.ok) expect(result.error).toContain("worker crashed");
  });

  it("refuses to compare embeddings of different dimensions even when the model name matches", async () => {
    const h = setupVisual();
    const tools = new Map(createVisualTools({ store: h.store, searcher: { model: FAKE_MODEL, embedText: async () => new Float32Array(CONCEPTS.length + 1) } }).map((t) => [t.name, t]));
    const result = await tools.get("find_visual_moments")?.run({ query: "dog", assetId: "a1" }, { editor: h.editor, nowMs: () => 0 });
    expect(result?.ok).toBe(false);
    if (result && !result.ok) expect(result.error).toContain("different models");
  });

  it("does not change the project", async () => {
    const h = setupVisual();
    await h.data("insert_media", { assetId: "a1" });
    const before = h.editor.getState().doc;
    await find(h, { assetId: "a1", query: "dog" });
    expect(h.editor.getState().doc).toBe(before);
  });
});

describe("index_visuals", () => {
  it("indexes an asset, saves it, and reuses the saved index unless forced", async () => {
    const h = setupVisual({ embeddings: [], withIndexer: true });
    const first = await h.data<{ frames: number; cached: boolean }>("index_visuals", { assetId: "a1" });
    expect(first).toMatchObject({ frames: 5, cached: false });
    expect(await h.store.get("a1")).toBeDefined();
    expect((await h.data<{ cached: boolean }>("index_visuals", { assetId: "a1" })).cached).toBe(true);
    await h.data("index_visuals", { assetId: "a1", force: true });
    expect(h.indexed).toEqual(["a1", "a1"]);
  });

  it("re-indexes when the saved index came from another model", async () => {
    const h = setupVisual({ embeddings: [makeEmbeddings({ model: "old/model", frames: A1_FRAMES })], withIndexer: true });
    expect((await h.data<{ cached: boolean }>("index_visuals", { assetId: "a1" })).cached).toBe(false);
    expect((await h.store.get("a1"))?.model).toBe(FAKE_MODEL);
  });

  it("makes the asset searchable afterwards", async () => {
    const h = setupVisual({ embeddings: [], withIndexer: true });
    await h.failure("find_visual_moments", { query: "dog", assetId: "a1" });
    await h.data("index_visuals", { assetId: "a1" });
    expect((await find(h, { query: "dog", assetId: "a1" })).moments).toHaveLength(1);
  });

  it("rejects non-video and unknown assets and turns indexer failures into hints", async () => {
    const h = setupVisual({ withIndexer: true });
    expect((await h.failure("index_visuals", { assetId: "music" })).error).toContain("only video");
    expect((await h.failure("index_visuals", { assetId: "nope" })).hint).toContain("list_assets");
    const broken = setupVisual({ embeddings: [], indexer: { index: async () => { throw new Error("no decoder"); } } });
    const failure = await broken.failure("index_visuals", { assetId: "a1" });
    expect(failure.error).toContain("no decoder");
    expect(failure.hint).toContain("Retry once");
    expect(await broken.store.get("a1")).toBeUndefined();
  });

  it("passes a consent refusal through with a do-not-retry hint", async () => {
    const refusal = Object.assign(new Error("Ask the user to press Index visuals."), { name: "ConsentRequiredError" });
    const h = setupVisual({ embeddings: [], indexer: { index: async () => { throw refusal; } } });
    const failure = await h.failure("index_visuals", { assetId: "a1" });
    expect(failure.error).toBe("Ask the user to press Index visuals.");
    expect(failure.hint).toContain("Do not retry");
  });
});

describe("compose with cut_to_moments", () => {
  it("cuts the moments found by what they look like into one undo step on the main track", async () => {
    const h = setupVisual();
    const { moments } = await find(h, { assetId: "a1", query: "dog", sort: "time" });
    const before = snapshotForUndo(h.editor);
    const cut = await h.data<CutData>("cut_to_moments", { moments: moments.map(({ assetId, startSeconds, endSeconds }) => ({ assetId, startSeconds, endSeconds })) });
    expect(cut.clips).toHaveLength(1);
    expect(cut.clips[0]).toMatchObject({ sourceStart: 2, sourceEnd: 6, start: 0, end: 4 });
    assertEditorHealthy(h.editor, "after visual cut");
    expect(h.editor.undo()).toBe(true);
    expect(snapshotForUndo(h.editor)).toEqual(before);
  });
});
