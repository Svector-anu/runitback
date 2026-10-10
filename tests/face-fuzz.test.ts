import { describe, expect, it } from "vitest";
import { callTool, createAgentTools, type AgentToolRegistry } from "#/engine/agent";
import { createFaceTools } from "#/engine/agent/tools-face";
import { insertMediaElement, updateElements } from "#/engine/commands";
import type { Editor } from "#/engine/editor";
import { FACE_REGIONS, type FaceBox, type FaceDetections, type FaceFrame } from "#/engine/face";
import { createMapAnalysisProvider } from "#/engine/reference";
import { TICKS_PER_SECOND } from "#/engine/time";
import { allElements } from "#/engine/timeline";
import { ASSETS } from "./agent-harness";
import { A1_CUTS, FAKE_FACE_MODEL, box, detections, frame, memoryFaceStore } from "./face-harness";
import { makeEditor, sec } from "./helpers";
import { assertEditorHealthy, makeRng, snapshotForUndo } from "./invariants-harness";
import { makeAnalysis } from "./temporal-harness";

const SEEDS = Array.from({ length: 24 }, (_, i) => i + 1);
const STEPS = 50;
const VIDEO_IDS = ["a1", "a2", "a3"] as const;
const PRESETS = ["16:9", "9:16", "1:1", "4:3"] as const;

type Rng = ReturnType<typeof makeRng>;

const durationOf = (assetId: string): number => (ASSETS.find((a) => a.id === assetId)?.duration ?? 0) / TICKS_PER_SECOND;

function randomBox(rng: Rng): FaceBox {
  const width = 0.04 + rng.next() * 0.3;
  const height = 0.05 + rng.next() * 0.4;
  return box(rng.next() * (1 - width), rng.next() * (1 - height), width, height, 0.3 + rng.next() * 0.7);
}

function randomDetections(rng: Rng, assetId: string): FaceDetections {
  const duration = durationOf(assetId);
  const count = 1 + rng.int(10);
  const times = Array.from({ length: count }, () => Math.round(rng.next() * duration * 100) / 100).sort((a, b) => a - b);
  const frames: FaceFrame[] = times.map((t) => frame(t, ...Array.from({ length: rng.chance(0.35) ? 0 : 1 + rng.int(3) }, () => randomBox(rng))));
  return detections({ assetId, durationSeconds: duration, frames, ...(rng.chance(0.1) ? { model: "stale/model" } : {}) });
}

function scenario(rng: Rng) {
  const { editor } = makeEditor({ assets: ASSETS });
  const store = memoryFaceStore();
  for (const id of VIDEO_IDS) if (rng.chance(0.85)) store.save(randomDetections(rng, id));
  const tools = new Map(createAgentTools());
  const analysis = createMapAnalysisProvider([makeAnalysis({ cuts: A1_CUTS })]);
  for (const tool of createFaceTools({ faces: store, analysis, model: FAKE_FACE_MODEL })) tools.set(tool.name, tool);
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

const ctxOf = (editor: Editor) => ({ editor, nowMs: () => 0 });

async function findStep(editor: Editor, tools: AgentToolRegistry, rng: Rng): Promise<void> {
  const limit = 1 + rng.int(8);
  const args = {
    ...(rng.chance(0.7) ? { assetId: rng.pick([...VIDEO_IDS, "music", "ghost"]) } : { allAssets: true }),
    ...(rng.chance(0.3) ? { present: false } : {}),
    ...(rng.chance(0.3) ? { minFaces: 1 + rng.int(3) } : {}),
    ...(rng.chance(0.2) ? { maxFaces: 1 + rng.int(3) } : {}),
    ...(rng.chance(0.3) ? { minSize: rng.next() * 0.5 } : {}),
    ...(rng.chance(0.3) ? { region: rng.pick(FACE_REGIONS) } : {}),
    ...(rng.chance(0.3) ? { sort: rng.pick(["time", "longest"]) } : {}),
    ...(rng.chance(0.5) ? { limit } : {}),
  };
  const before = snapshotForUndo(editor);
  const result = await callTool({ tools, name: "find_face_moments", args, ctx: ctxOf(editor) });
  expect(snapshotForUndo(editor), "find_face_moments is read-only").toBe(before);
  if (!result.ok) return;
  const { moments } = result.data as { moments: Array<{ assetId: string; startSeconds: number; endSeconds: number }> };
  if ("limit" in args) expect(moments.length).toBeLessThanOrEqual(limit);
  for (const m of moments) {
    expect(m.startSeconds).toBeGreaterThanOrEqual(0);
    expect(m.endSeconds).toBeGreaterThan(m.startSeconds);
    expect(m.endSeconds).toBeLessThanOrEqual(durationOf(m.assetId) + 1e-6);
  }
}

async function describeStep(editor: Editor, tools: AgentToolRegistry, rng: Rng): Promise<void> {
  const before = snapshotForUndo(editor);
  const result = await callTool({ tools, name: "describe_faces", args: { assetId: rng.pick([...VIDEO_IDS, "music", "ghost"]) }, ctx: ctxOf(editor) });
  expect(snapshotForUndo(editor), "describe_faces is read-only").toBe(before);
  if (!result.ok) return;
  for (const shot of (result.data as { shots: Array<{ presentRatio: number; meanFaces: number }> }).shots) {
    expect(shot.presentRatio).toBeGreaterThanOrEqual(0);
    expect(shot.presentRatio).toBeLessThanOrEqual(1);
    expect(shot.meanFaces).toBeGreaterThanOrEqual(0);
  }
}

async function reframeStep(editor: Editor, tools: AgentToolRegistry, rng: Rng, label: string): Promise<boolean> {
  const elements = allElements(editor.tracks());
  const target = rng.chance(0.9) && elements.length > 0 ? rng.pick(elements).element.id : "ghost";
  const args = { elementId: target, ...(rng.chance(0.4) ? { subject: rng.pick(["largest", "all"]) } : {}), ...(rng.chance(0.4) ? { zoom: rng.pick(["auto", "none"]) } : {}) };
  const before = snapshotForUndo(editor);
  const result = await callTool({ tools, name: "reframe_to_faces", args, ctx: ctxOf(editor) });
  assertEditorHealthy(editor, label);
  if (!result.ok) {
    expect(snapshotForUndo(editor), `${label}: a rejected reframe must not change the document`).toBe(before);
    return false;
  }
  const clip = allElements(editor.tracks()).find((l) => l.element.id === target)?.element;
  for (const path of ["transform.positionX", "transform.positionY", "transform.scaleX", "transform.scaleY"]) {
    const binding = clip?.animations?.[path];
    expect(binding?.kind, `${label}: ${path} is animated`).toBe("channel");
    if (binding?.kind !== "channel") continue;
    const times = binding.channel.keys.map((k) => k.time);
    expect(times, `${label}: ${path} keyframe times ascend inside the clip`).toEqual([...times].sort((a, b) => a - b));
    expect(times[0]).toBe(0);
    expect(times[times.length - 1]).toBeLessThanOrEqual(clip?.duration ?? 0);
    for (const key of binding.channel.keys) expect(Number.isFinite(key.value as number)).toBe(true);
  }
  const after = snapshotForUndo(editor);
  expect(editor.undo(), `${label}: success must leave one undo step`).toBe(true);
  expect(snapshotForUndo(editor), `${label}: one undo restores the document`).toBe(before);
  expect(editor.redo()).toBe(true);
  expect(snapshotForUndo(editor)).toBe(after);
  assertEditorHealthy(editor, `${label} after redo`);
  return true;
}

describe("fuzz: find_face_moments, describe_faces and reframe_to_faces", () => {
  for (const seed of SEEDS) {
    it(`seed ${seed}: random face tool calls never break a document invariant and each reframe is one undo step`, async () => {
      const rng = makeRng(52000 + seed);
      const { editor, tools } = scenario(rng);
      assertEditorHealthy(editor, `seed ${seed} setup`);
      for (let step = 0; step < STEPS; step++) {
        const roll = rng.next();
        if (roll < 0.3) await findStep(editor, tools, rng);
        else if (roll < 0.4) await describeStep(editor, tools, rng);
        else if (roll < 0.45) await callTool({ tools, name: "set_project", args: { canvasPreset: rng.pick(PRESETS) }, ctx: ctxOf(editor) });
        else if (roll < 0.55) await callTool({ tools, name: "set_speed", args: { elementId: rng.pick([...allElements(editor.tracks()).map((l) => l.element.id), "ghost"]), speed: rng.pick([0.5, 1, 2, 3]) }, ctx: ctxOf(editor) });
        else await reframeStep(editor, tools, rng, `seed ${seed} step ${step}`);
        assertEditorHealthy(editor, `seed ${seed} step ${step}`);
      }
      while (editor.undo()) assertEditorHealthy(editor, `seed ${seed} undoing`);
    });
  }

  it("exercises successful reframes across the seeds", async () => {
    let reframed = 0;
    for (const seed of SEEDS) {
      const rng = makeRng(52000 + seed);
      const { editor, tools } = scenario(rng);
      for (let step = 0; step < STEPS; step++) if (await reframeStep(editor, tools, rng, `count ${seed}/${step}`)) reframed++;
    }
    expect(reframed).toBeGreaterThan(40);
  });
});
