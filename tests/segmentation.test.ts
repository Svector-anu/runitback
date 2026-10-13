import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it } from "vitest";
import { callTool, createAgentTools, createBackgroundTools, type BackgroundDeps } from "#/engine/agent";
import type { VideoElement } from "#/engine/model";
import {
  MASK_MAX_FPS, MASK_MAX_FRAMES, MASK_TRACK_VERSION, isUsableMaskTrack, maskAlphaTable, maskAt, maskCoverage, planMaskTimes, type MaskTrack,
} from "#/engine/segmentation";
import { allElements } from "#/engine/timeline";
import { IdbMaskStore, MaskProvider, MemoryMaskStore, SEGMENTER_MODELS, createSegmentationIndexer, modelFor, type SegmentBackend } from "#/platform/segmentation";
import { setupAgent, tracksOf, type InsertedData } from "./agent-harness";

const MODEL = SEGMENTER_MODELS.selfie_segmenter;
const track = (overrides: Partial<MaskTrack> = {}): MaskTrack => ({
  version: MASK_TRACK_VERSION, assetId: "a1", model: MODEL, width: 4, height: 2, durationSeconds: 2,
  times: [0, 1, 2], frames: [new Uint8Array(8).fill(0), new Uint8Array(8).fill(200), new Uint8Array(8).fill(100)], ...overrides,
});

describe("sampling plan", () => {
  it("samples at the clip's frame rate up to the cap, evenly, and once for a still", () => {
    expect(planMaskTimes({ durationSeconds: 2, fps: 24 })).toHaveLength(2 * MASK_MAX_FPS);
    expect(planMaskTimes({ durationSeconds: 2, fps: 6 })).toEqual([0, 1 / 6, 2 / 6, 3 / 6, 4 / 6, 5 / 6, 1, 7 / 6, 8 / 6, 9 / 6, 10 / 6, 11 / 6].map((v) => expect.closeTo(v, 9)));
    expect(planMaskTimes({ durationSeconds: 10, isStill: true })).toEqual([0]);
    expect(planMaskTimes({ durationSeconds: 0 })).toEqual([0]);
    expect(planMaskTimes({ durationSeconds: 10 * 3600 })).toHaveLength(MASK_MAX_FRAMES);
    const times = planMaskTimes({ durationSeconds: 7.3, fps: 30 });
    expect(times.every((t, i) => i === 0 || t > (times[i - 1] as number))).toBe(true);
    expect(times[times.length - 1]).toBeLessThan(7.3);
  });
});

describe("maskAt", () => {
  it("holds the first and last sample outside the range and blends between samples", () => {
    const t = track();
    expect(maskAt(t, -5).data[0]).toBe(0);
    expect(maskAt(t, 0).data[0]).toBe(0);
    expect(maskAt(t, 2).data[0]).toBe(100);
    expect(maskAt(t, 99).data[0]).toBe(100);
    expect(maskAt(t, 0.5).data[0]).toBeCloseTo(100, -1);
    expect(maskAt(t, 0.25).data[0]).toBeCloseTo(50, -1);
    expect(maskAt(t, 1.5).data[0]).toBeCloseTo(150, -1);
    expect(maskAt(t, 1).data[0]).toBe(200);
  });
  it("reuses the sample when exactly on it (no copy) and never leaves 0..255", () => {
    const t = track();
    expect(maskAt(t, 1).data).toBe(t.frames[1]);
    for (let s = 0; s <= 2; s += 0.07) for (const v of maskAt(t, s).data) { expect(v).toBeGreaterThanOrEqual(0); expect(v).toBeLessThanOrEqual(255); }
  });
  it("coverage counts confident pixels", () => {
    expect(maskCoverage({ width: 2, height: 2, data: new Uint8Array([255, 255, 0, 0]) })).toBe(0.5);
  });
});

describe("alpha table", () => {
  it("is monotonic, passes 0 and 255 through, and softness widens the edge; invert flips it", () => {
    const hard = maskAlphaTable({ softness: 0, invert: false });
    const soft = maskAlphaTable({ softness: 100, invert: false });
    for (const table of [hard, soft]) {
      expect(table[0]).toBe(0);
      expect(table[255]).toBe(255);
      for (let v = 1; v < 256; v++) expect(table[v] as number).toBeGreaterThanOrEqual(table[v - 1] as number);
    }
    expect(hard[110]).toBeLessThan(soft[110] as number);
    expect(hard[150]).toBeGreaterThan(soft[150] as number);
    const inverted = maskAlphaTable({ softness: 40, invert: true });
    const normal = maskAlphaTable({ softness: 40, invert: false });
    for (let v = 0; v < 256; v += 17) expect((inverted[v] as number) + (normal[v] as number)).toBeCloseTo(255, -1);
  });
});

describe("track validation", () => {
  it("accepts a well-formed track of the right model and rejects the rest", () => {
    expect(isUsableMaskTrack(track(), MODEL)).toBe(true);
    expect(isUsableMaskTrack(track(), "other")).toBe(false);
    expect(isUsableMaskTrack(track({ version: 0 }), MODEL)).toBe(false);
    expect(isUsableMaskTrack(track({ frames: [new Uint8Array(3)], times: [0] }), MODEL)).toBe(false);
    expect(isUsableMaskTrack(track({ times: [0] }), MODEL)).toBe(false);
    expect(isUsableMaskTrack(null, MODEL)).toBe(false);
    expect(isUsableMaskTrack({}, MODEL)).toBe(false);
  });
  it("picks the landscape model for wide footage and the square one otherwise", () => {
    expect(modelFor(1920, 1080)).toBe("selfie_segmenter_landscape");
    expect(modelFor(1080, 1920)).toBe("selfie_segmenter");
    expect(modelFor(1000, 1000)).toBe("selfie_segmenter");
  });
});

describe("stores and provider", () => {
  it("IndexedDB round-trips Uint8 masks and drops tracks of an unknown model", async () => {
    const store = new IdbMaskStore(new IDBFactory());
    await store.save(track());
    const back = await store.get("a1");
    expect(back?.frames[1]).toBeInstanceOf(Uint8Array);
    expect(Array.from(back?.frames[1] ?? [])).toEqual(Array(8).fill(200));
    await store.save(track({ assetId: "old", model: "mediapipe/other" }));
    expect(await store.get("old")).toBeUndefined();
    expect((await store.assetIds()).sort()).toEqual(["a1", "old"]);
    await store.delete("a1");
    expect(await store.get("a1")).toBeUndefined();
  });

  it("the provider loads lazily from the store, serves interpolated masks synchronously and notifies on changes", async () => {
    const store = new MemoryMaskStore();
    await store.save(track());
    const provider = new MaskProvider(store);
    let notifications = 0;
    provider.subscribe(() => { notifications++; });
    expect(provider.has("a1")).toBe(false);
    expect(provider.get("a1", 0.5)).toBeNull();
    await Promise.all([provider.ensure("a1"), provider.ensure("a1")]);
    expect(provider.get("a1", 0.5)?.data[0]).toBeCloseTo(100, -1);
    await provider.ensure("missing");
    expect(provider.has("missing")).toBe(false);
    await provider.put(track({ assetId: "b" }));
    await provider.remove("a1");
    expect(notifications).toBe(2);
    expect(provider.has("a1")).toBe(false);
    expect(await store.get("a1")).toBeUndefined();
    expect(await store.get("b")).toBeDefined();
  });
});

function fakeBackend(log: number[] = []): SegmentBackend {
  return {
    async segment({ frames }) {
      log.push(frames.length);
      return frames.map((f) => ({ time: f.time, width: 3, height: 2, data: new Uint8Array(6).fill(Math.round(f.time * 10) % 256) }));
    },
    dispose() { /* nothing to release */ },
  };
}

describe("segmentation indexer", () => {
  const frames = { frameAt: async () => ({ width: 8, height: 4, data: new Uint8ClampedArray(8 * 4 * 4) }), dispose: async () => undefined };

  it("segments every planned time in batches, reports progress, and keeps times in order", async () => {
    const batches: number[] = [];
    const progress: number[] = [];
    const result = await createSegmentationIndexer({ createBackend: () => fakeBackend(batches), openFrames: () => frames })
      .index({ assetId: "v", blob: new Blob(), kind: "video", width: 1920, height: 1080, durationSeconds: 3, fps: 4, onProgress: (p) => progress.push(p) });
    expect(result.frames).toHaveLength(12);
    expect(batches).toEqual([6, 6]);
    expect(result.model).toBe(SEGMENTER_MODELS.selfie_segmenter_landscape);
    expect(result.times).toEqual(planMaskTimes({ durationSeconds: 3, fps: 4 }));
    expect(progress[progress.length - 1]).toBe(1);
    expect(progress.every((p, i) => i === 0 || p >= (progress[i - 1] as number))).toBe(true);
    expect(isUsableMaskTrack(result, result.model)).toBe(true);
  });

  it("segments a still image once", async () => {
    const result = await createSegmentationIndexer({ createBackend: () => fakeBackend(), openFrames: () => frames })
      .index({ assetId: "i", blob: new Blob(), kind: "image", width: 800, height: 1000, durationSeconds: 5 });
    expect(result.times).toEqual([0]);
    expect(result.model).toBe(SEGMENTER_MODELS.selfie_segmenter);
  });

  it("aborts promptly, disposes the worker and the decoder, and reports an AbortError", async () => {
    const controller = new AbortController();
    let backendDisposed = 0, sourceDisposed = 0;
    const slow: SegmentBackend = {
      async segment({ frames: batch }) { controller.abort(); return batch.map((f) => ({ time: f.time, width: 1, height: 1, data: new Uint8Array(1) })); },
      dispose() { backendDisposed++; },
    };
    const run = createSegmentationIndexer({ createBackend: () => slow, openFrames: () => ({ ...frames, dispose: async () => { sourceDisposed++; } }) })
      .index({ assetId: "v", blob: new Blob(), kind: "video", width: 100, height: 100, durationSeconds: 10, fps: 10, signal: controller.signal });
    await expect(run).rejects.toMatchObject({ name: "AbortError" });
    expect(backendDisposed).toBeGreaterThanOrEqual(1);
    expect(sourceDisposed).toBe(1);
    await expect(createSegmentationIndexer({ createBackend: () => fakeBackend(), openFrames: () => frames })
      .index({ assetId: "v", blob: new Blob(), kind: "video", width: 1, height: 1, durationSeconds: 1, signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
  });

  it("fails clearly when no frame can be decoded or the model misbehaves", async () => {
    const none = { frameAt: async () => null, dispose: async () => undefined };
    await expect(createSegmentationIndexer({ createBackend: () => fakeBackend(), openFrames: () => none })
      .index({ assetId: "v", blob: new Blob(), kind: "video", width: 1, height: 1, durationSeconds: 1 })).rejects.toThrow(/No frames/);
    const short: SegmentBackend = { async segment() { return []; }, dispose() { /* nothing */ } };
    await expect(createSegmentationIndexer({ createBackend: () => short, openFrames: () => frames })
      .index({ assetId: "v", blob: new Blob(), kind: "video", width: 1, height: 1, durationSeconds: 1 })).rejects.toThrow(/returned 0 masks/);
  });
});

describe("remove_background tool", () => {
  function setup(ready: boolean, share = 0.6) {
    const analysed: string[] = [];
    const deps: BackgroundDeps = {
      isReady: async (id) => ready || analysed.includes(id),
      analyze: async ({ assetId }) => { analysed.push(assetId); return { frames: 10, personShare: share }; },
    };
    const h = setupAgent();
    const tools = new Map(createAgentTools());
    for (const tool of createBackgroundTools(deps)) tools.set(tool.name, tool);
    const call = (name: string, args: unknown) => callTool({ tools, name, args, ctx: { editor: h.editor, nowMs: () => 0 } });
    return { h, call, analysed };
  }
  const effects = (h: ReturnType<typeof setupAgent>, id: string) => (allElements(tracksOf(h.editor)).find((l) => l.element.id === id)?.element as VideoElement).effects ?? [];

  it("analyses media on first use, adds one effect, edits it later, never stacks, and undoes in one step", async () => {
    const { h, call, analysed } = setup(false);
    const clip = await h.data<InsertedData>("insert_media", { assetId: "a1" });
    const first = await call("remove_background", { elementIds: [clip.elementId] });
    expect(first.ok).toBe(true);
    expect(analysed).toEqual(["a1"]);
    await call("remove_background", { elementIds: [clip.elementId], softness: 70, invert: true });
    expect(analysed).toEqual(["a1"]);
    expect(effects(h, clip.elementId)).toHaveLength(1);
    expect(effects(h, clip.elementId)[0]).toMatchObject({ type: "remove-background", enabled: true, params: { softness: 70, invert: true } });
    h.editor.undo();
    expect(effects(h, clip.elementId)[0]?.params.softness).toBe(40);
  });

  it("warns when no person was found, removes, and rejects bad input", async () => {
    const { h, call } = setup(false, 0.01);
    const clip = await h.data<InsertedData>("insert_media", { assetId: "a1" });
    const result = await call("remove_background", { elementIds: [clip.elementId] });
    expect(result.ok && result.summary).toMatch(/No person was found/);
    expect((await call("remove_background", { elementIds: [clip.elementId], remove: true })).ok).toBe(true);
    expect(effects(h, clip.elementId)).toHaveLength(0);
    expect((await call("remove_background", { elementIds: [clip.elementId], remove: true })).ok).toBe(false);
    expect((await call("remove_background", { elementIds: [] })).ok).toBe(false);
    expect((await call("remove_background", { elementIds: [clip.elementId], softness: 500 })).ok).toBe(false);
    const music = await h.data<InsertedData>("insert_media", { assetId: "music" });
    expect((await call("remove_background", { elementIds: [music.elementId] })).ok).toBe(false);
  });

  it("turns an analysis failure into a readable tool error and changes nothing", async () => {
    const h = setupAgent();
    const tools = new Map(createAgentTools());
    for (const tool of createBackgroundTools({ isReady: async () => false, analyze: async () => { throw new Error("model unavailable"); } })) tools.set(tool.name, tool);
    const clip = await h.data<InsertedData>("insert_media", { assetId: "a1" });
    const result = await callTool({ tools, name: "remove_background", args: { elementIds: [clip.elementId] }, ctx: { editor: h.editor, nowMs: () => 0 } });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/model unavailable/);
    expect(effects(h, clip.elementId)).toHaveLength(0);
  });
});
