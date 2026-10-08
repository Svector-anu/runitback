import { describe, expect, it } from "vitest";
import { callTool, createAgentTools, createTemporalTools, type AgentToolRegistry } from "#/engine/agent";
import { insertMediaElement, updateElements } from "#/engine/commands";
import type { Editor } from "#/engine/editor";
import { createMapAnalysisProvider } from "#/engine/reference";
import { allElements } from "#/engine/timeline";
import { createMemoryTranscriptStore, type TranscriptWord } from "#/engine/transcript";
import { ASSETS } from "./agent-harness";
import { makeEditor, sec } from "./helpers";
import { assertEditorHealthy, makeRng, snapshotForUndo } from "./invariants-harness";
import { makeAnalysis, transcriptOf } from "./temporal-harness";

const SEEDS = Array.from({ length: 24 }, (_, i) => i + 1);
const STEPS = 50;
const VOCABULARY = ["um", "so", "we", "budget", "skip", "this", "part.", "okay,", "right?", "and", "then"];
const VIDEO_IDS = ["a1", "a2", "a3"] as const;

type Rng = ReturnType<typeof makeRng>;

function randomWords(rng: Rng, durationSeconds: number): TranscriptWord[] {
  const words: TranscriptWord[] = [];
  let cursor = rng.next() * 0.5;
  while (cursor < durationSeconds - 0.3 && words.length < 40) {
    const end = Math.min(durationSeconds, cursor + 0.05 + rng.next() * 0.6);
    words.push({ text: rng.pick(VOCABULARY), startSeconds: cursor, endSeconds: end });
    cursor = end + (rng.chance(0.3) ? 0 : rng.next() * 0.8);
  }
  return words;
}

function randomAnalysis(rng: Rng, assetId: string, duration: number) {
  const cuts = Array.from({ length: rng.int(5) }, () => 0.2 + rng.next() * (duration - 0.4));
  const silences = Array.from({ length: rng.int(4) }, () => {
    const start = rng.next() * (duration - 1);
    return { start, end: start + 0.2 + rng.next() * 0.8 };
  }).sort((a, b) => a.start - b.start).filter((s, i, all) => i === 0 || s.start >= (all[i - 1] as { end: number }).end);
  return makeAnalysis({
    assetId, duration, cuts: [...new Set(cuts.map((c) => Math.round(c * 100) / 100))], silences,
    levels: Array.from({ length: 6 }, () => -60 + rng.next() * 50), hasAudio: rng.chance(0.9),
    ...(rng.chance(0.5) ? { tempo: { bpm: 60 + rng.int(100), confidence: rng.next() } } : {}),
  });
}

function scenario(rng: Rng) {
  const { editor } = makeEditor({ assets: ASSETS });
  const store = createMemoryTranscriptStore();
  const analyses = VIDEO_IDS.flatMap((id) => {
    const duration = (ASSETS.find((a) => a.id === id)?.duration ?? 0) / 120000;
    if (rng.chance(0.85)) store.save(transcriptOf(id, randomWords(rng, duration)));
    return rng.chance(0.85) ? [randomAnalysis(rng, id, duration)] : [];
  });
  const tools = new Map(createAgentTools());
  for (const tool of createTemporalTools({ analysis: createMapAnalysisProvider(analyses), transcripts: store })) tools.set(tool.name, tool);
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
  return { editor, tools };
}

interface Found { assetId: string; startSeconds: number; endSeconds: number }

async function findStep(editor: Editor, tools: AgentToolRegistry, rng: Rng): Promise<Found[]> {
  const args = {
    ...(rng.chance(0.7) ? { assetId: rng.pick(VIDEO_IDS) } : { allAssets: true }),
    ...(rng.chance(0.4) ? { text: rng.pick(VOCABULARY) } : {}),
    ...(rng.chance(0.2) ? { shot: rng.int(5) } : {}),
    ...(rng.chance(0.2) ? { minLoudnessDb: -60 + rng.next() * 50 } : {}),
    ...(rng.chance(0.2) ? { maxLoudnessDb: -60 + rng.next() * 50 } : {}),
    ...(rng.chance(0.2) ? { silent: rng.chance(0.5) } : {}),
    ...(rng.chance(0.2) ? { speaking: rng.chance(0.5) } : {}),
    ...(rng.chance(0.2) ? { startSeconds: rng.next() * 4, endSeconds: 4 + rng.next() * 6 } : {}),
    ...(rng.chance(0.5) ? { sort: rng.pick(["relevance", "time", "loudest", "quietest", "longest"]) } : {}),
    ...(rng.chance(0.5) ? { limit: 1 + rng.int(8) } : {}),
  };
  const before = snapshotForUndo(editor);
  const result = await callTool({ tools, name: "find_moments", args, ctx: { editor, nowMs: () => 0 } });
  expect(snapshotForUndo(editor), "find_moments is read-only").toBe(before);
  return result.ok ? ((result.data as { moments: Found[] }).moments) : [];
}

async function cutStep(editor: Editor, tools: AgentToolRegistry, rng: Rng, pool: Found[], label: string): Promise<boolean> {
  const count = 1 + rng.int(4);
  const moments = Array.from({ length: count }, () => {
    const found = pool.length > 0 && rng.chance(0.75) ? rng.pick(pool) : undefined;
    if (found) return rng.chance(0.15) ? { ...found, startSeconds: found.endSeconds, endSeconds: found.startSeconds } : found;
    const start = rng.next() * 9;
    return { assetId: rng.pick([...VIDEO_IDS, "ghost", "music", "photo"]), startSeconds: start, endSeconds: start + rng.next() * 3 };
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

describe("fuzz: find_moments and cut_to_moments", () => {
  for (const seed of SEEDS) {
    it(`seed ${seed}: random queries and cuts never break a document invariant and each cut is one undo step`, async () => {
      const rng = makeRng(9000 + seed);
      const { editor, tools } = scenario(rng);
      assertEditorHealthy(editor, `seed ${seed} setup`);
      let cuts = 0;
      let pool: Found[] = [];
      for (let step = 0; step < STEPS; step++) {
        if (rng.chance(0.5)) pool = [...pool, ...(await findStep(editor, tools, rng))].slice(-30);
        else if (await cutStep(editor, tools, rng, pool, `seed ${seed} step ${step}`)) cuts++;
        if (rng.chance(0.1)) editor.setRippleEnabled(rng.chance(0.5));
      }
      expect(cuts + pool.length, "the fuzzer should exercise real calls").toBeGreaterThan(0);
      while (editor.undo()) assertEditorHealthy(editor, `seed ${seed} undoing`);
    });
  }

  it("exercises successful cuts across the seeds", async () => {
    let total = 0;
    for (const seed of SEEDS) {
      const rng = makeRng(9000 + seed);
      const { editor, tools } = scenario(rng);
      let pool: Found[] = [];
      for (let step = 0; step < STEPS; step++) {
        pool = [...pool, ...(await findStep(editor, tools, rng))].slice(-30);
        if (await cutStep(editor, tools, rng, pool, `count ${seed}/${step}`)) total++;
      }
    }
    expect(total).toBeGreaterThan(20);
  });
});
