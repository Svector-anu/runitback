import { describe, expect, it } from "vitest";
import { callTool, createAgentTools, type ToolResult } from "#/engine/agent";
import { currentScene } from "#/engine/commands";
import { planBeatSnap } from "#/engine/beatsync";
import { type SceneTracks, type TimelineElement } from "#/engine/model";
import { createMapAnalysisProvider, createMemoryStyleProfileStore } from "#/engine/reference";
import { elementEnd, sceneViolations } from "#/engine/timeline";
import { TICKS_PER_SECOND } from "#/engine/time";
import { ASSETS, tracksOf } from "./agent-harness";
import { syntheticAnalysis } from "./reference-fixtures";
import { image, makeEditor, sec, tracksWith, video } from "./helpers";

const FPS = { numerator: 30, denominator: 1 };

function setup(bpm = 120) {
  const { editor } = makeEditor({ assets: ASSETS });
  const provider = createMapAnalysisProvider([syntheticAnalysis({ assetId: "music", lengths: [30], bpm })]);
  const tools = createAgentTools({ reference: { store: createMemoryStyleProfileStore(), provider } });
  const ctx = { editor, nowMs: () => 0 };
  const call = (name: string, args: unknown = {}): Promise<ToolResult> => callTool({ tools, name, args, ctx });
  return { editor, call };
}

const clips = (tracks: SceneTracks): TimelineElement[] => (tracks.main.elements as TimelineElement[]).slice().sort((a, b) => a.startTime - b.startTime);
const seconds = (ticks: number): number => ticks / TICKS_PER_SECOND;

async function montage(cutsAt: number[]) {
  const h = setup();
  expect((await h.call("insert_media", { assetId: "music", start: 0 })).ok).toBe(true);
  expect((await h.call("insert_media", { assetId: "a1", start: 0 })).ok).toBe(true);
  for (const at of cutsAt) expect((await h.call("split", { at })).ok, `split ${at}`).toBe(true);
  return h;
}

describe("snap_cuts_to_beat", () => {
  it("moves cuts within tolerance onto the 0.5 s beat grid and keeps length, order and source mapping", async () => {
    const h = await montage([1.1, 2.5, 3.9]);
    const before = clips(tracksOf(h.editor));
    const lengthBefore = elementEnd(before[before.length - 1] as TimelineElement);
    const result = await h.call("snap_cuts_to_beat", { toleranceSeconds: 0.2 });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    const after = clips(tracksOf(h.editor));
    expect(after.slice(1).map((c) => seconds(c.startTime))).toEqual([1, 2.5, 4]);
    expect(elementEnd(after[after.length - 1] as TimelineElement)).toBe(lengthBefore);
    for (let i = 0; i + 1 < after.length; i++) expect(elementEnd(after[i] as TimelineElement)).toBe((after[i + 1] as TimelineElement).startTime);
    expect(sceneViolations(currentScene(h.editor.getState().doc))).toEqual([]);
    const first = after[0] as TimelineElement;
    const second = after[1] as TimelineElement;
    expect(second.trimStart).toBe(first.trimStart + first.duration);
    if (result.ok) expect(result.data).toMatchObject({ moved: 2, onBeatAfter: 3 });
  });

  it("is one undo step", async () => {
    const h = await montage([1.1, 3.9]);
    const doc = h.editor.getState().doc;
    await h.call("snap_cuts_to_beat", { toleranceSeconds: 0.2 });
    expect(h.editor.getState().doc).not.toBe(doc);
    h.editor.undo();
    expect(h.editor.getState().doc).toBe(doc);
  });

  it("leaves cuts alone outside the tolerance and in dryRun, and reports honestly", async () => {
    const h = await montage([1.2]);
    const doc = h.editor.getState().doc;
    const far = await h.call("snap_cuts_to_beat", { toleranceSeconds: 0.05 });
    expect(far.ok && far.data).toMatchObject({ moved: 0, skipped: { "no-beat-in-tolerance": 1 } });
    const dry = await h.call("snap_cuts_to_beat", { toleranceSeconds: 0.3, dryRun: true });
    expect(dry.ok && dry.data).toMatchObject({ moved: 1, dryRun: true });
    expect(h.editor.getState().doc).toBe(doc);
  });

  it("only snaps cuts next to the given clips", async () => {
    const h = await montage([1.1, 3.9]);
    const [first] = clips(tracksOf(h.editor));
    const result = await h.call("snap_cuts_to_beat", { toleranceSeconds: 0.2, elementIds: [(first as TimelineElement).id] });
    expect(result.ok && result.data).toMatchObject({ cuts: 1, moved: 1 });
    expect(clips(tracksOf(h.editor)).slice(1).map((c) => Math.round(seconds(c.startTime) * 100) / 100)).toEqual([1, 3.9]);
  });

  it("fails clearly without music", async () => {
    const h = setup();
    await h.call("insert_media", { assetId: "a1", start: 0 });
    await h.call("split", { at: 2 });
    const result = await h.call("snap_cuts_to_beat");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/no beats/i);
  });
});

describe("planBeatSnap", () => {
  const beats = Array.from({ length: 40 }, (_, i) => i * 0.5);

  it("skips a cut that has no spare media on either side", () => {
    const tracks = tracksWith({ main: [video("a", 0, 6), video("b", 6, 8)] });
    const plan = planBeatSnap({ tracks, beatsSeconds: [5.9, 6.1], toleranceSeconds: 0.2, fps: FPS });
    expect(plan.moves).toEqual([]);
    expect(plan.skipped.map((s) => s.reason)).toEqual(["not-enough-media"]);
  });

  it("never shrinks a neighbour below one frame and never touches gaps", () => {
    const tracks = tracksWith({ main: [video("a", 0, 6), video("b", 6, 8)] });
    const gap = tracksWith({ main: [video("a", 0, 5), video("b", 5.5, 4)] });
    expect(planBeatSnap({ tracks: gap, beatsSeconds: beats, toleranceSeconds: 0.5, fps: FPS }).cutCount).toBe(0);
    expect(planBeatSnap({ tracks, beatsSeconds: beats, toleranceSeconds: 0.5, fps: FPS }).moves).toEqual([]);
  });

  it("lets an image clip, which has no source limits, grow or shrink either way", () => {
    const tracks = tracksWith({ main: [video("a", 0, 6), image("i", 6, 3)] });
    const plan = planBeatSnap({ tracks, beatsSeconds: [5.9], toleranceSeconds: 0.2, fps: FPS });
    expect(plan.moves).toHaveLength(1);
    const right = plan.updates.find((u) => u.ref.elementId === "i");
    expect(right?.patch).toMatchObject({ startTime: sec(5.9), duration: sec(3.1) });
    expect(right?.patch.trimStart).toBeUndefined();
  });
});

describe("snap_cuts_to_beat fuzz", () => {
  it("keeps the timeline valid and every split continuous over random cut positions", async () => {
    let seed = 11;
    const rand = (): number => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    for (let run = 0; run < 25; run++) {
      const cuts = new Set<number>();
      while (cuts.size < 5) cuts.add(Math.round((0.5 + rand() * 8.5) * 30) / 30);
      const h = await montage([...cuts].sort((a, b) => b - a));
      const lengthBefore = elementEnd(clips(tracksOf(h.editor)).at(-1) as TimelineElement);
      const tolerance = 0.05 + rand() * 0.4;
      const result = await h.call("snap_cuts_to_beat", { toleranceSeconds: tolerance });
      expect(result.ok, JSON.stringify(result)).toBe(true);
      const after = clips(tracksOf(h.editor));
      expect(sceneViolations(currentScene(h.editor.getState().doc))).toEqual([]);
      expect(elementEnd(after.at(-1) as TimelineElement)).toBe(lengthBefore);
      for (let i = 0; i + 1 < after.length; i++) {
        const left = after[i] as TimelineElement;
        const right = after[i + 1] as TimelineElement;
        expect(elementEnd(left)).toBe(right.startTime);
        expect(Math.abs(right.trimStart - (left.trimStart + left.duration))).toBeLessThanOrEqual(2);
      }
      for (const m of result.ok ? ((result.data as { moves: Array<{ from: number; to: number }> }).moves) : []) {
        expect(Math.abs(m.to - m.from)).toBeLessThanOrEqual(tolerance + 1e-3);
      }
    }
  });
});
