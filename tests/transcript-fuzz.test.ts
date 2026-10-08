import { describe, expect, it } from "vitest";
import { callTool } from "#/engine/agent";
import { insertMediaElement, updateElements } from "#/engine/commands";
import type { Editor } from "#/engine/editor";
import { allElements } from "#/engine/timeline";
import { createMemoryTranscriptStore, TRANSCRIPT_VERSION, type TranscriptWord } from "#/engine/transcript";
import { createAgentTools } from "#/engine/agent";
import { createTranscriptTools } from "#/engine/agent/tools-transcript";
import { ASSETS } from "./agent-harness";
import { makeEditor, sec } from "./helpers";
import { assertEditorHealthy, makeRng, snapshotForUndo } from "./invariants-harness";

const SEEDS = Array.from({ length: 24 }, (_, i) => i + 1);
const STEPS = 60;
const VOCABULARY = ["um", "so", "we", "should", "skip", "this", "part.", "okay,", "right?", "and", "then"];
const SPEECH_ASSETS = ["a1", "a2", "a3"] as const;

type Rng = ReturnType<typeof makeRng>;

function randomWords(rng: Rng, durationSeconds: number): TranscriptWord[] {
  const words: TranscriptWord[] = [];
  let cursor = rng.next() * 0.5;
  while (cursor < durationSeconds - 0.3 && words.length < 40) {
    const length = 0.05 + rng.next() * 0.6;
    const end = Math.min(durationSeconds, cursor + length);
    words.push({ text: rng.pick(VOCABULARY), startSeconds: cursor, endSeconds: end });
    cursor = end + (rng.chance(0.3) ? 0 : rng.next() * 0.8);
  }
  return words;
}

function scenario(rng: Rng) {
  const { editor } = makeEditor({ assets: ASSETS });
  const store = createMemoryTranscriptStore();
  for (const id of SPEECH_ASSETS) {
    const asset = ASSETS.find((a) => a.id === id);
    store.save({ version: TRANSCRIPT_VERSION, assetId: id, language: "en", model: "fuzz", words: randomWords(rng, (asset?.duration ?? 0) / 120000) });
  }
  const tools = new Map(createAgentTools());
  for (const tool of createTranscriptTools({ store })) tools.set(tool.name, tool);
  for (let i = 0; i < 3; i++) {
    const asset = ASSETS[rng.int(SPEECH_ASSETS.length)];
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

function pickRange(rng: Rng, store: ReturnType<typeof scenario>["store"], assetId: string): Record<string, unknown> {
  const words = (store.get(assetId) as { words: TranscriptWord[] }).words;
  const first = rng.int(Math.max(1, words.length));
  const last = Math.min(words.length - 1, first + rng.int(5));
  const choice = rng.int(4);
  if (choice === 0) return { phrase: rng.pick(VOCABULARY), ...(rng.chance(0.5) ? { occurrence: 1 + rng.int(3) } : {}) };
  if (choice === 1) return { phrase: words.slice(first, last + 1).map((w) => w.text).join(" ") };
  return { startWord: first, ...(rng.chance(0.7) ? { endWord: last } : {}) };
}

async function deleteStep(editor: Editor, tools: ReturnType<typeof scenario>["tools"], store: ReturnType<typeof scenario>["store"], rng: Rng, label: string): Promise<void> {
  const ids = allElements(editor.tracks()).filter((l) => "mediaId" in l.element).map((l) => l.element);
  const target = ids.length > 0 && rng.chance(0.95) ? rng.pick(ids) : undefined;
  const assetId = target && "mediaId" in target ? target.mediaId : "a1";
  const args = {
    elementId: target?.id ?? "ghost",
    ...pickRange(rng, store, assetId),
    ...(rng.chance(0.5) ? { ripple: rng.chance(0.5) } : {}),
    ...(rng.chance(0.4) ? { padSeconds: rng.pick([0, 0.02, 0.1, 0.5, 1]) } : {}),
  };
  const before = snapshotForUndo(editor);
  const ctx = { editor, nowMs: () => 0 };
  const result = await callTool({ tools, name: "delete_spoken_range", args, ctx });
  assertEditorHealthy(editor, label);
  if (!result.ok) {
    expect(snapshotForUndo(editor), `${label}: a rejected call must not change the document`).toBe(before);
    return;
  }
  const after = snapshotForUndo(editor);
  expect(editor.undo(), `${label}: success must leave one undo step`).toBe(true);
  expect(snapshotForUndo(editor), `${label}: one undo restores the document`).toBe(before);
  expect(editor.redo()).toBe(true);
  expect(snapshotForUndo(editor)).toBe(after);
  assertEditorHealthy(editor, `${label} after redo`);
}

describe("fuzz: delete_spoken_range", () => {
  for (const seed of SEEDS) {
    it(`seed ${seed}: random phrase and index deletions never break a document invariant`, async () => {
      const rng = makeRng(5000 + seed);
      const { editor, tools, store } = scenario(rng);
      assertEditorHealthy(editor, `seed ${seed} setup`);
      let succeeded = 0;
      for (let step = 0; step < STEPS; step++) {
        const before = snapshotForUndo(editor);
        await deleteStep(editor, tools, store, rng, `seed ${seed} step ${step}`);
        if (snapshotForUndo(editor) !== before) succeeded++;
        if (rng.chance(0.1)) editor.setRippleEnabled(rng.chance(0.5));
      }
      expect(succeeded, "the fuzzer should exercise real edits").toBeGreaterThan(0);
      while (editor.undo()) assertEditorHealthy(editor, `seed ${seed} undoing`);
    });
  }
});
