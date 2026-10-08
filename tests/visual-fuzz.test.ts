import { describe, expect, it } from "vitest";
import { callTool, createAgentTools, createTemporalTools, createVisualTools, type AgentToolRegistry } from "#/engine/agent";
import { insertMediaElement, updateElements } from "#/engine/commands";
import type { Editor } from "#/engine/editor";
import { createMapAnalysisProvider } from "#/engine/reference";
import { allElements } from "#/engine/timeline";
import { createMemoryTranscriptStore } from "#/engine/transcript";
import { createMemoryVisualStore, type VisualEmbeddings } from "#/engine/visual";
import { ASSETS } from "./agent-harness";
import { makeEditor, sec } from "./helpers";
import { assertEditorHealthy, makeRng, snapshotForUndo } from "./invariants-harness";
import { CONCEPTS, fakeSearcher, makeEmbeddings, type Concept } from "./visual-harness";

const SEEDS = Array.from({ length: 24 }, (_, i) => i + 1);
const STEPS = 50;
const VIDEO_IDS = ["a1", "a2", "a3"] as const;
const QUERIES = ["dog", "whiteboard", "someone laugh", "sky", "a submarine", "dog sky"];

type Rng = ReturnType<typeof makeRng>;

function randomEmbeddings(rng: Rng, assetId: string, durationSeconds: number): VisualEmbeddings {
  const cuts = Array.from({ length: rng.int(4) }, () => Math.round((0.3 + rng.next() * (durationSeconds - 0.6)) * 100) / 100);
  const count = 1 + rng.int(9);
  const times = Array.from({ length: count }, () => Math.round(rng.next() * (durationSeconds - 0.05) * 1000) / 1000)
    .sort((a, b) => a - b).filter((t, i, all) => i === 0 || t > (all[i - 1] as number));
  const frames = times.map((time) => ({
    time,
    mix: Object.fromEntries(CONCEPTS.filter(() => rng.chance(0.4)).map((c): [Concept, number] => [c, 0.1 + rng.next()])) as Partial<Record<Concept, number>>,
  }));
  return makeEmbeddings({ assetId, durationSeconds, cuts, frames, ...(rng.chance(0.15) ? { model: "stale/model" } : {}) });
}

function scenario(rng: Rng) {
  const { editor } = makeEditor({ assets: ASSETS });
  const store = createMemoryVisualStore();
  for (const id of VIDEO_IDS) {
    const duration = (ASSETS.find((a) => a.id === id)?.duration ?? 0) / 120000;
    if (rng.chance(0.85)) store.save(randomEmbeddings(rng, id, duration));
  }
  const searcher = fakeSearcher();
  const tools = new Map(createAgentTools());
  const indexer = {
    async index({ assetId }: { assetId: string }) {
      if (rng.chance(0.3)) throw new Error("decoder failed");
      const duration = (ASSETS.find((a) => a.id === assetId)?.duration ?? 0) / 120000;
      return randomEmbeddings(rng, assetId, duration);
    },
  };
  for (const tool of createTemporalTools({ analysis: createMapAnalysisProvider([]), transcripts: createMemoryTranscriptStore() })) tools.set(tool.name, tool);
  for (const tool of createVisualTools({ store, searcher, indexer })) tools.set(tool.name, tool);
  for (let i = 0; i < 3; i++) {
    const asset = ASSETS[rng.int(VIDEO_IDS.length)];
    if (!asset) continue;
    editor.execute(insertMediaElement({
      asset, elementId: editor.newId(), startTime: sec(Math.floor(rng.next() * 12)), placement: rng.chance(0.6) ? { mode: "auto" } : { mode: "newTrack", index: -1, trackId: undefined },
    }));
  }
  for (const located of allElements(editor.tracks())) {
    if (rng.chance(0.5)) editor.execute(updateElements([{ ref: located.ref, patch: { retime: { rate: rng.pick([0.5, 0.75, 1.5, 2, 3.7]), maintainPitch: false } } as never }], "Speed"));
  }
  return { editor, tools, store };
}

interface Found { assetId: string; startSeconds: number; endSeconds: number; score: number }

const durationOf = (assetId: string): number => (ASSETS.find((a) => a.id === assetId)?.duration ?? 0) / 120000;

async function findStep(editor: Editor, tools: AgentToolRegistry, rng: Rng): Promise<Found[]> {
  const limit = 1 + rng.int(8);
  const minScore = rng.chance(0.4) ? rng.next() : undefined;
  const args = {
    query: rng.chance(0.05) ? "" : rng.pick(QUERIES),
    ...(rng.chance(0.7) ? { assetId: rng.pick([...VIDEO_IDS, "music", "ghost"]) } : { allAssets: true }),
    ...(minScore === undefined ? {} : { minScore }),
    ...(rng.chance(0.5) ? { sort: rng.pick(["relevance", "time"]) } : {}),
    ...(rng.chance(0.5) ? { limit } : {}),
  };
  const before = snapshotForUndo(editor);
  const result = await callTool({ tools, name: "find_visual_moments", args, ctx: { editor, nowMs: () => 0 } });
  expect(snapshotForUndo(editor), "find_visual_moments is read-only").toBe(before);
  if (!result.ok) return [];
  const { moments } = result.data as { moments: Found[] };
  if ("limit" in args) expect(moments.length).toBeLessThanOrEqual(limit);
  for (const m of moments) {
    expect(m.startSeconds).toBeGreaterThanOrEqual(0);
    expect(m.endSeconds).toBeGreaterThan(m.startSeconds);
    expect(m.endSeconds).toBeLessThanOrEqual(durationOf(m.assetId) + 1e-6);
    if (minScore !== undefined) expect(m.score).toBeGreaterThanOrEqual(Math.round(minScore * 1000) / 1000 - 1e-3);
  }
  for (const id of VIDEO_IDS) {
    const own = moments.filter((m) => m.assetId === id).sort((a, b) => a.startSeconds - b.startSeconds);
    own.forEach((m, i) => { if (i > 0) expect(m.startSeconds, "moments of one asset never overlap").toBeGreaterThanOrEqual((own[i - 1] as Found).endSeconds - 1e-6); });
  }
  return moments;
}

async function indexStep(editor: Editor, tools: AgentToolRegistry, store: ReturnType<typeof createMemoryVisualStore>, rng: Rng): Promise<void> {
  const before = snapshotForUndo(editor);
  await callTool({ tools, name: "index_visuals", args: { assetId: rng.pick([...VIDEO_IDS, "music", "ghost"]), ...(rng.chance(0.4) ? { force: true } : {}) }, ctx: { editor, nowMs: () => 0 } });
  expect(snapshotForUndo(editor), "index_visuals does not touch the document").toBe(before);
  for (const id of VIDEO_IDS) {
    const saved = await store.get(id);
    if (saved) expect(saved.vectors.length).toBe(saved.times.length * saved.dimensions);
  }
}

async function cutStep(editor: Editor, tools: AgentToolRegistry, rng: Rng, pool: Found[], label: string): Promise<boolean> {
  const count = 1 + rng.int(4);
  const moments = Array.from({ length: count }, () => {
    const found = pool.length > 0 && rng.chance(0.8) ? rng.pick(pool) : undefined;
    if (found) return found;
    const start = rng.next() * 9;
    return { assetId: rng.pick([...VIDEO_IDS, "ghost", "music"]), startSeconds: start, endSeconds: start + rng.next() * 3 };
  }).map(({ assetId, startSeconds, endSeconds }) => ({ assetId, startSeconds, endSeconds }));
  const args = { moments, ...(rng.chance(0.3) ? { startSeconds: Math.floor(rng.next() * 30) } : {}) };
  const before = snapshotForUndo(editor);
  const result = await callTool({ tools, name: "cut_to_moments", args, ctx: { editor, nowMs: () => 0 } });
  assertEditorHealthy(editor, label);
  if (!result.ok) {
    expect(snapshotForUndo(editor), `${label}: a rejected cut must not change the document`).toBe(before);
    return false;
  }
  const after = snapshotForUndo(editor);
  expect(editor.undo(), `${label}: success must leave one undo step`).toBe(true);
  expect(snapshotForUndo(editor), `${label}: one undo restores the document`).toBe(before);
  expect(editor.redo()).toBe(true);
  expect(snapshotForUndo(editor)).toBe(after);
  assertEditorHealthy(editor, `${label} after redo`);
  return true;
}

describe("fuzz: find_visual_moments, index_visuals and cut_to_moments", () => {
  for (const seed of SEEDS) {
    it(`seed ${seed}: random searches and cuts never break a document invariant and each cut is one undo step`, async () => {
      const rng = makeRng(31000 + seed);
      const { editor, tools, store } = scenario(rng);
      assertEditorHealthy(editor, `seed ${seed} setup`);
      let pool: Found[] = [];
      for (let step = 0; step < STEPS; step++) {
        const roll = rng.next();
        if (roll < 0.45) pool = [...pool, ...(await findStep(editor, tools, rng))].slice(-30);
        else if (roll < 0.55) await indexStep(editor, tools, store, rng);
        else await cutStep(editor, tools, rng, pool, `seed ${seed} step ${step}`);
        if (rng.chance(0.1)) editor.setRippleEnabled(rng.chance(0.5));
      }
      while (editor.undo()) assertEditorHealthy(editor, `seed ${seed} undoing`);
    });
  }

  it("exercises successful searches and cuts across the seeds", async () => {
    let cuts = 0;
    let found = 0;
    for (const seed of SEEDS) {
      const rng = makeRng(31000 + seed);
      const { editor, tools } = scenario(rng);
      let pool: Found[] = [];
      for (let step = 0; step < STEPS; step++) {
        const moments = await findStep(editor, tools, rng);
        found += moments.length;
        pool = [...pool, ...moments].slice(-30);
        if (await cutStep(editor, tools, rng, pool, `count ${seed}/${step}`)) cuts++;
      }
    }
    expect(found).toBeGreaterThan(100);
    expect(cuts).toBeGreaterThan(20);
  });
});
