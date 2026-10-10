import { describe, expect, it } from "vitest";
import { createAgentTools } from "#/engine/agent";
import { createFaceTools } from "#/engine/agent/tools-face";
import type { Editor } from "#/engine/editor";
import { FACE_INDEX_VERSION, type FaceIndexer } from "#/engine/face";
import { TICKS_PER_SECOND } from "#/engine/time";
import { allElements } from "#/engine/timeline";
import type { InsertedData } from "./agent-harness";
import { FAKE_FACE_MODEL, detections, frame, setupFaces, speaker, type FaceHarness } from "./face-harness";
import { videoAsset } from "./helpers";
import { assertEditorHealthy, snapshotForUndo } from "./invariants-harness";

interface FoundMoment {
  assetId: string; startSeconds: number; endSeconds: number; frames: number; maxFaces: number; meanFaces: number; largestSize: number;
  timeline?: Array<{ elementId: string; startSeconds: number; endSeconds: number }>;
}
interface FindData { moments: FoundMoment[]; truncated: boolean; skipped: Array<{ assetId: string; reason: string }>; unit: string }
interface ReframeData { elementId: string; keyframes: number; replacedAnimation: string[]; facesFoundInWindow: number; sourceWindow: { startSeconds: number; endSeconds: number } }

const PATHS = ["transform.positionX", "transform.positionY", "transform.scaleX", "transform.scaleY"] as const;
const CANVAS = { width: 1080, height: 1920 };
const CONTAIN = 0.5625;

function keysOf(editor: Editor, elementId: string, path: string): Array<{ timeSeconds: number; value: number }> {
  const element = allElements(editor.tracks()).find((l) => l.element.id === elementId)?.element;
  const binding = element?.animations?.[path];
  if (!binding || binding.kind !== "channel") return [];
  return binding.channel.keys.map((k) => ({ timeSeconds: k.time / TICKS_PER_SECOND, value: k.value as number }));
}

/** Where the horizontal source position `sourceX` (0..1) lands on the 9:16 canvas for the keyframe at index `i`. */
function canvasX(editor: Editor, elementId: string, i: number, sourceX: number): number {
  const posX = keysOf(editor, elementId, "transform.positionX")[i]?.value ?? Number.NaN;
  const scale = keysOf(editor, elementId, "transform.scaleX")[i]?.value ?? Number.NaN;
  return CANVAS.width / 2 + posX + (sourceX - 0.5) * 1920 * CONTAIN * scale;
}

/** The first clip on an empty project sets the canvas to its own shape, so the 9:16 canvas is chosen after inserting it. */
async function placed(h: FaceHarness, assetId = "a1"): Promise<string> {
  const { elementId } = await h.data<InsertedData>("insert_media", { assetId });
  await h.data("set_project", { canvasPreset: "9:16" });
  return elementId;
}

describe("registry", () => {
  it("is opt-in and flags only reframe_to_faces as editing", () => {
    expect([...createAgentTools().keys()].filter((n) => /face/.test(n))).toEqual([]);
    const { tools } = setupFaces();
    expect(["find_face_moments", "describe_faces", "reframe_to_faces"].map((n) => tools.get(n)?.readOnly)).toEqual([true, true, false]);
    expect(tools.has("index_faces")).toBe(false);
  });

  it("offers index_faces only when an indexer is supplied", () => {
    const indexer: FaceIndexer = { async index({ assetId }) { return detections({ assetId, frames: [] }); } };
    expect(setupFaces({ indexer }).tools.get("index_faces")?.readOnly).toBe(true);
  });
});

describe("find_face_moments", () => {
  it("finds presence moments in source seconds and maps them onto a clip", async () => {
    const h = setupFaces();
    const clip = await h.data<InsertedData>("insert_media", { assetId: "a1" });
    const data = await h.data<FindData>("find_face_moments", { assetId: "a1" });
    expect(data.unit).toBe("source seconds");
    expect(data.moments.map((m) => [m.startSeconds, m.endSeconds, m.maxFaces])).toEqual([[0, 4, 1], [6, 10, 2]]);
    expect(data.moments[1]?.timeline).toEqual([{ elementId: clip.elementId, startSeconds: 6, endSeconds: 10 }]);
  });

  it("maps through speed and trims like the other moment tools", async () => {
    const h = setupFaces();
    const clip = await h.data<InsertedData>("insert_media", { assetId: "a1" });
    await h.data("trim", { elementId: clip.elementId, start: 2 });
    await h.data("set_speed", { elementId: clip.elementId, speed: 2 });
    const data = await h.data<FindData>("find_face_moments", { assetId: "a1", sort: "time" });
    expect(data.moments.map((m) => [m.startSeconds, m.endSeconds])).toEqual([[0, 4], [6, 10]]);
    expect(data.moments.map((m) => m.timeline?.map((r) => [r.startSeconds, r.endSeconds]))).toEqual([[[0, 1]], [[2, 4]]]);
  });

  it("answers absence, counts, size, region, longest and range queries", async () => {
    const h = setupFaces();
    const spans = async (args: Record<string, unknown>) => (await h.data<FindData>("find_face_moments", { assetId: "a1", ...args })).moments.map((m) => [m.startSeconds, m.endSeconds]);
    expect(await spans({ present: false })).toEqual([[4, 6]]);
    expect(await spans({ minFaces: 2 })).toEqual([[6, 8]]);
    expect(await spans({ region: "right" })).toEqual([[6, 10]]);
    expect(await spans({ minSize: 0.5 })).toEqual([]);
    expect(await spans({ sort: "longest", limit: 1 })).toEqual([[0, 4]]);
    expect(await spans({ startSeconds: 2, endSeconds: 7 })).toEqual([[2, 4], [6, 7]]);
  });

  it("reports truncation and skips videos without face data under allAssets", async () => {
    const h = setupFaces();
    const data = await h.data<FindData>("find_face_moments", { allAssets: true, limit: 1 });
    expect(data.moments).toHaveLength(1);
    expect(data.truncated).toBe(true);
    expect(data.skipped.map((s) => [s.assetId, s.reason]).sort()).toEqual([["a2", "no-face-data"], ["a3", "no-face-data"]]);
  });

  it("is read-only", async () => {
    const h = setupFaces();
    await h.data("insert_media", { assetId: "a1" });
    const before = snapshotForUndo(h.editor);
    await h.data("find_face_moments", { assetId: "a1" });
    expect(snapshotForUndo(h.editor)).toBe(before);
  });

  it("fails honestly: no data, stale model, wrong asset kinds and contradictory arguments", async () => {
    const h = setupFaces();
    const none = await h.failure("find_face_moments", { assetId: "a2" });
    expect(none.error).toContain("no face data");
    expect(none.hint).toContain("face detection");
    expect((await h.failure("find_face_moments", { assetId: "photo" })).error).toContain("image");
    expect((await h.failure("find_face_moments", { assetId: "ghost" })).hint).toContain("list_assets");
    expect((await h.failure("find_face_moments", {})).error).toContain("exactly one");
    expect((await h.failure("find_face_moments", { assetId: "a1", present: false, minFaces: 2 })).error).toContain("present:false");
    expect((await h.failure("find_face_moments", { assetId: "a1", minFaces: 3, maxFaces: 2 })).error).toContain("below");
    const stale = setupFaces({ model: "other/model" });
    expect((await stale.failure("find_face_moments", { assetId: "a1" })).error).toContain("outdated");
    expect((await setupFaces({ faces: [] }).failure("find_face_moments", { allAssets: true })).error).toContain("None of the videos");
  });
});

describe("describe_faces", () => {
  it("summarises each shot using the scene cuts of the analysis", async () => {
    const h = setupFaces();
    const result = await h.call("describe_faces", { assetId: "a1" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const data = result.data as { shots: Array<{ shot: number; startSeconds: number; endSeconds: number; presentRatio: number; meanFaces: number; position?: string }> };
    expect(data.shots.map((s) => [s.shot, s.startSeconds, s.endSeconds, s.presentRatio, s.meanFaces, s.position])).toEqual([
      [0, 0, 4, 1, 1, "left"], [1, 4, 8, 0.5, 1, "left"], [2, 8, 10, 1, 1, "right"],
    ]);
    expect(result.summary).toContain("SOURCE seconds");
    expect(result.summary).toContain("face in 100% of 2 frame(s)");
  });

  it("is a single shot without scene analysis and says so", async () => {
    const result = await setupFaces({ withAnalysis: false }).call("describe_faces", { assetId: "a1" });
    expect(result.ok && result.summary).toContain("whole video is one shot");
    expect(result.ok && (result.data as { shots: unknown[] }).shots).toHaveLength(1);
  });

  it("fails without data", async () => {
    expect((await setupFaces().failure("describe_faces", { assetId: "a3" })).error).toContain("no face data");
  });
});

describe("reframe_to_faces", () => {
  it("writes position and scale keyframes that put the speaker in the middle of a 9:16 canvas", async () => {
    const h = setupFaces();
    const id = await placed(h);
    const data = await h.data<ReframeData>("reframe_to_faces", { elementId: id });
    expect(data.keyframes).toBeGreaterThanOrEqual(2);
    for (const path of PATHS) expect(keysOf(h.editor, id, path)).toHaveLength(data.keyframes);
    const times = keysOf(h.editor, id, "transform.positionX").map((k) => k.timeSeconds);
    expect(times[0]).toBe(0);
    expect(times[times.length - 1]).toBe(10);
    expect(times).toEqual([...times].sort((a, b) => a - b));
    expect(canvasX(h.editor, id, 0, 0.25)).toBeCloseTo(CANVAS.width / 2, 3);
    expect(keysOf(h.editor, id, "transform.positionX")[0]?.value).toBeGreaterThan(0);
    expect(keysOf(h.editor, id, "transform.positionX")[data.keyframes - 1]?.value).toBeLessThan(0);
    assertEditorHealthy(h.editor, "after reframe");
  });

  it("is one undo step and redo restores it", async () => {
    const h = setupFaces();
    const id = await placed(h);
    const before = snapshotForUndo(h.editor);
    await h.data("reframe_to_faces", { elementId: id });
    const after = snapshotForUndo(h.editor);
    expect(h.editor.undo()).toBe(true);
    expect(snapshotForUndo(h.editor)).toBe(before);
    expect(h.editor.redo()).toBe(true);
    expect(snapshotForUndo(h.editor)).toBe(after);
  });

  it("honours speed: keyframe times are source times divided by the rate, ending at the clip's end", async () => {
    const h = setupFaces();
    const id = await placed(h);
    await h.data("set_speed", { elementId: id, speed: 2 });
    await h.data("reframe_to_faces", { elementId: id });
    const times = keysOf(h.editor, id, "transform.positionX").map((k) => k.timeSeconds);
    expect(times[0]).toBe(0);
    expect(times[times.length - 1]).toBe(5);
    for (const t of times) expect([0, 0.5, 1.5, 2.5, 3.5, 4.5, 5]).toContain(t);
    expect(canvasX(h.editor, id, 0, 0.25)).toBeCloseTo(CANVAS.width / 2, 3);
  });

  it("honours trims: the keyframes frame the part that plays, not the start of the source", async () => {
    const h = setupFaces();
    const id = await placed(h);
    await h.data("split", { at: 6 });
    const tail = allElements(h.editor.tracks()).find((l) => l.element.id !== id && l.element.type === "video")?.element;
    expect(tail).toBeDefined();
    if (!tail) return;
    const data = await h.data<ReframeData>("reframe_to_faces", { elementId: tail.id });
    expect(data.sourceWindow).toEqual({ startSeconds: 6, endSeconds: 10 });
    const times = keysOf(h.editor, tail.id, "transform.positionX").map((k) => k.timeSeconds);
    expect(times[0]).toBe(0);
    expect(times[times.length - 1]).toBe(4);
    expect(keysOf(h.editor, id, "transform.positionX")).toEqual([]);
    expect(keysOf(h.editor, tail.id, "transform.positionX")[data.keyframes - 1]?.value).toBeLessThan(0);
  });

  it("replaces earlier position animation and makes scale uniform", async () => {
    const h = setupFaces();
    const id = await placed(h);
    await h.data("add_keyframe", { elementId: id, property: "transform.positionX", time: 1, value: 50 });
    await h.data("add_keyframe", { elementId: id, property: "transform.positionX", time: 2, value: 90 });
    const data = await h.data<ReframeData>("reframe_to_faces", { elementId: id });
    expect(data.replacedAnimation).toEqual(["transform.positionX"]);
    expect(keysOf(h.editor, id, "transform.positionX").map((k) => k.value)).not.toContain(50);
    expect(keysOf(h.editor, id, "transform.positionX").map((k) => k.value)).not.toContain(90);
    expect(keysOf(h.editor, id, "transform.scaleX")).toEqual(keysOf(h.editor, id, "transform.scaleY"));
  });

  it("fails honestly when there is nothing to reframe on, leaving the document alone", async () => {
    const noData = setupFaces();
    const a2 = (await noData.data<InsertedData>("insert_media", { assetId: "a2" })).elementId;
    const before = snapshotForUndo(noData.editor);
    const missing = await noData.failure("reframe_to_faces", { elementId: a2 });
    expect(missing.error).toContain("no face data");
    expect(snapshotForUndo(noData.editor)).toBe(before);

    const empty = setupFaces({ faces: [detections({ frames: [frame(1), frame(3)] })] });
    const id = (await empty.data<InsertedData>("insert_media", { assetId: "a1" })).elementId;
    expect((await empty.failure("reframe_to_faces", { elementId: id })).error).toContain("anywhere");

    const gap = setupFaces();
    const g = (await gap.data<InsertedData>("insert_media", { assetId: "a1" })).elementId;
    await gap.data("trim", { elementId: g, start: 4.2 });
    await gap.data("trim", { elementId: g, end: 1.6 });
    const outside = await gap.failure("reframe_to_faces", { elementId: g });
    expect(outside.error).toContain("part of the video this clip plays");
    expect(outside.hint).toContain("find_face_moments");

    expect((await gap.failure("reframe_to_faces", { elementId: "ghost" })).hint).toContain("get_timeline");
    const photo = (await gap.data<InsertedData>("insert_media", { assetId: "photo" })).elementId;
    expect((await gap.failure("reframe_to_faces", { elementId: photo })).error).toContain("image");
  });

  it("with subject all and zoom none keeps both speakers in the window", async () => {
    const h = setupFaces({ faces: [detections({ frames: [frame(1, speaker(0.4), speaker(0.6)), frame(5, speaker(0.4), speaker(0.6)), frame(9, speaker(0.4), speaker(0.6))] })] });
    const id = await placed(h);
    await h.data("reframe_to_faces", { elementId: id, subject: "all", zoom: "none" });
    expect(canvasX(h.editor, id, 0, 0.5)).toBeCloseTo(CANVAS.width / 2, 3);
    expect(new Set(keysOf(h.editor, id, "transform.scaleX").map((k) => k.value.toFixed(3))).size).toBe(1);
  });

  it("thins a very long path to a bounded number of keyframes", async () => {
    const frames = Array.from({ length: 600 }, (_, i) => frame(i * 0.5 + 0.25, speaker(i % 2 === 0 ? 0.3 : 0.7)));
    const long = { ...videoAsset("long", 300), id: "long" };
    const h = setupFaces({ assets: [long], faces: [detections({ assetId: "long", durationSeconds: 300, frames })] });
    const id = await placed(h, "long");
    const data = await h.data<ReframeData>("reframe_to_faces", { elementId: id });
    expect(data.keyframes).toBeLessThanOrEqual(200);
    expect(keysOf(h.editor, id, "transform.positionX")).toHaveLength(data.keyframes);
  });
});

describe("index_faces", () => {
  it("indexes once, saves, then reuses the stored data", async () => {
    const indexed: string[] = [];
    const indexer: FaceIndexer = {
      async index({ assetId }) {
        indexed.push(assetId);
        return { version: FACE_INDEX_VERSION, assetId, model: FAKE_FACE_MODEL, durationSeconds: 6, frames: [frame(1, speaker(0.5))] };
      },
    };
    const h = setupFaces({ indexer });
    expect((await h.data<{ cached: boolean }>("index_faces", { assetId: "a3" })).cached).toBe(false);
    expect((await h.data<{ cached: boolean }>("index_faces", { assetId: "a3" })).cached).toBe(true);
    expect(indexed).toEqual(["a3"]);
    await h.data("index_faces", { assetId: "a3", force: true });
    expect(indexed).toEqual(["a3", "a3"]);
    expect(h.store.saved.map((d) => d.assetId)).toEqual(["a3", "a3"]);
    expect((await h.data<FindData>("find_face_moments", { assetId: "a3" })).moments).toHaveLength(1);
  });

  it("turns indexer failures into a retry hint and offers index_faces in the missing-data hint", async () => {
    const indexer: FaceIndexer = { async index() { throw new Error("decoder failed"); } };
    const h = setupFaces({ indexer });
    expect((await h.failure("index_faces", { assetId: "a3" })).error).toContain("decoder failed");
    expect((await h.failure("find_face_moments", { assetId: "a3" })).hint).toContain("index_faces");
  });
});

it("accepts a deps object without optional parts", () => {
  expect(createFaceTools({ faces: { get: () => undefined, save: () => undefined, delete: () => undefined } }).map((t) => t.name)).toEqual([
    "find_face_moments", "describe_faces", "reframe_to_faces",
  ]);
});
