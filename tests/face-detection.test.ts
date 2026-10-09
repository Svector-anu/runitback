import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it } from "vitest";
import { FACE_INDEX_VERSION, framesWithFaces, isUsableFaceDetections, type FaceBox, type FaceDetections } from "#/engine/face";
import {
  DEFAULT_FACE_MODEL, FACE_DB_NAME, FACE_FRAME_BATCH_SIZE, IdbFaceStore, createFaceEngine, createFaceIndexer, toFractionBox,
  type FaceBackend, type FrameSource, type ImagePixels,
} from "#/platform/visual";

const pixels = (shade: number): ImagePixels => ({ width: 100, height: 50, data: new Uint8ClampedArray([shade, shade, shade, 255]) });
const box = (overrides: Partial<FaceBox> = {}): FaceBox => ({ x: 0.1, y: 0.2, width: 0.3, height: 0.4, score: 0.9, ...overrides });
const detections = (overrides: Partial<FaceDetections> = {}): FaceDetections => ({
  version: FACE_INDEX_VERSION, assetId: "a1", model: DEFAULT_FACE_MODEL, durationSeconds: 10,
  frames: [{ t: 1, boxes: [box()] }, { t: 3, boxes: [] }], ...overrides,
});

describe("face detections record", () => {
  it("accepts a well-formed record of the current version and model", () => {
    expect(isUsableFaceDetections(detections(), DEFAULT_FACE_MODEL)).toBe(true);
    expect(framesWithFaces(detections())).toBe(1);
  });

  it("rejects another model, another version, unordered frames and degenerate boxes", () => {
    expect(isUsableFaceDetections(detections(), "other/model")).toBe(false);
    expect(isUsableFaceDetections(detections({ version: 99 as typeof FACE_INDEX_VERSION }), DEFAULT_FACE_MODEL)).toBe(false);
    expect(isUsableFaceDetections(detections({ frames: [{ t: 3, boxes: [] }, { t: 1, boxes: [] }] }), DEFAULT_FACE_MODEL)).toBe(false);
    expect(isUsableFaceDetections(detections({ frames: [{ t: 1, boxes: [box({ width: 0 })] }] }), DEFAULT_FACE_MODEL)).toBe(false);
    expect(isUsableFaceDetections(detections({ frames: [{ t: 1, boxes: [box({ score: 1.5 })] }] }), DEFAULT_FACE_MODEL)).toBe(false);
  });
});

describe("toFractionBox", () => {
  it("normalises a pixel box by the frame size", () => {
    const normalised = toFractionBox({ box: { originX: 20, originY: 10, width: 40, height: 20 }, score: 0.8, frameWidth: 100, frameHeight: 50 });
    expect([normalised.x, normalised.y, normalised.width, normalised.height, normalised.score]).toEqual([0.2, 0.2, 0.4, 0.4, 0.8].map((v) => expect.closeTo(v, 6)));
  });

  it("clips a box that leaves the frame", () => {
    const clipped = toFractionBox({ box: { originX: -10, originY: 40, width: 50, height: 30 }, score: 1.2, frameWidth: 100, frameHeight: 50 });
    expect(clipped.x).toBe(0);
    expect(clipped.width).toBeCloseTo(0.4);
    expect(clipped.y).toBeCloseTo(0.8);
    expect(clipped.height).toBeCloseTo(0.2);
    expect(clipped.score).toBe(1);
  });
});

describe("createFaceEngine", () => {
  it("loads the detector once, keeps timestamps strictly increasing and drops empty boxes", async () => {
    let loads = 0;
    const stamps: number[] = [];
    const engine = createFaceEngine({
      async loadDetector() {
        loads++;
        return async ({ timestampMs }) => { stamps.push(timestampMs); return [box(), box({ width: 0 })]; };
      },
    });
    const first = await engine.detect({ frames: [{ time: 1, pixels: pixels(0) }, { time: 1.0004, pixels: pixels(0) }] });
    await engine.detect({ frames: [{ time: 2, pixels: pixels(0) }] });
    expect(loads).toBe(1);
    expect(stamps).toEqual([1000, 1001, 2000]);
    expect(first.map((f) => [f.t, f.boxes.length])).toEqual([[1, 1], [1.0004, 1]]);
  });

  it("retries loading after a failure", async () => {
    let loads = 0;
    const engine = createFaceEngine({
      async loadDetector() {
        loads++;
        if (loads === 1) throw new Error("no wasm");
        return async () => [];
      },
    });
    await expect(engine.detect({ frames: [{ time: 0, pixels: pixels(0) }] })).rejects.toThrow("no wasm");
    expect(await engine.detect({ frames: [{ time: 0, pixels: pixels(0) }] })).toEqual([{ t: 0, boxes: [] }]);
  });
});

interface Log { batches: number[]; disposed: number; requested: number[]; framesDisposed: number }

function fakes(options: { missingFrames?: number[]; abort?: AbortController; faceBelow?: number } = {}) {
  const log: Log = { batches: [], disposed: 0, requested: [], framesDisposed: 0 };
  const backend: FaceBackend = {
    async detect({ frames }) {
      log.batches.push(frames.length);
      options.abort?.abort();
      return frames.map((frame) => ({ t: frame.time, boxes: frame.time < (options.faceBelow ?? Infinity) ? [box()] : [] }));
    },
    dispose() { log.disposed++; },
  };
  const source: FrameSource = {
    async frameAt(seconds) {
      log.requested.push(seconds);
      return options.missingFrames?.includes(seconds) ? null : pixels(0);
    },
    async dispose() { log.framesDisposed++; },
  };
  return { log, backend, source };
}

describe("createFaceIndexer with a fake backend", () => {
  it("samples like the CLIP indexer, batches frames and returns versioned detections per frame", async () => {
    const { log, backend, source } = fakes({ faceBelow: 20 });
    const indexer = createFaceIndexer({
      getVideo: () => new Blob(), getFootage: async () => ({ durationSeconds: 40, cutTimes: [10, 20] }),
      intervalSeconds: 2, createBackend: () => backend, openFrames: () => source,
    });
    const progress: number[] = [];
    const result = await indexer.index({ assetId: "a1", onProgress: (f) => progress.push(f) });
    expect(result.version).toBe(FACE_INDEX_VERSION);
    expect(result.model).toBe(DEFAULT_FACE_MODEL);
    expect(result.durationSeconds).toBe(40);
    expect(result.frames.map((f) => f.t)).toEqual(log.requested);
    expect(result.frames.every((f) => (f.t < 20) === (f.boxes.length > 0))).toBe(true);
    expect(isUsableFaceDetections(result, DEFAULT_FACE_MODEL)).toBe(true);
    expect(log.batches.every((n) => n <= FACE_FRAME_BATCH_SIZE)).toBe(true);
    expect([...progress].sort((a, b) => a - b)).toEqual(progress);
    expect(progress[progress.length - 1]).toBe(1);
    expect(log.disposed).toBe(1);
    expect(log.framesDisposed).toBe(1);
  });

  it("skips frames that cannot be decoded", async () => {
    const { backend, source } = fakes({ missingFrames: [1] });
    const indexer = createFaceIndexer({
      getVideo: () => new Blob(), getFootage: async () => ({ durationSeconds: 6, cutTimes: [] }), intervalSeconds: 2, createBackend: () => backend, openFrames: () => source,
    });
    expect((await indexer.index({ assetId: "a1" })).frames.map((f) => f.t)).not.toContain(1);
  });

  it("fails when no frame can be decoded or the media is missing, and releases resources", async () => {
    const none = fakes({ missingFrames: [1, 3, 5] });
    const empty = createFaceIndexer({
      getVideo: () => new Blob(), getFootage: async () => ({ durationSeconds: 6, cutTimes: [] }), intervalSeconds: 2, createBackend: () => none.backend, openFrames: () => none.source,
    });
    await expect(empty.index({ assetId: "a1" })).rejects.toThrow("no video frames");
    expect(none.log.disposed).toBe(1);
    expect(none.log.framesDisposed).toBe(1);
    const missing = createFaceIndexer({ getVideo: () => undefined, getFootage: async () => ({ durationSeconds: 6, cutTimes: [] }) });
    await expect(missing.index({ assetId: "gone" })).rejects.toThrow("not loaded");
  });

  it("aborts with an AbortError and cleans up", async () => {
    const controller = new AbortController();
    const { log, backend, source } = fakes({ abort: controller });
    const indexer = createFaceIndexer({
      getVideo: () => new Blob(), getFootage: async () => ({ durationSeconds: 60, cutTimes: [] }), intervalSeconds: 2, createBackend: () => backend, openFrames: () => source,
    });
    await expect(indexer.index({ assetId: "a1", signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(log.framesDisposed).toBe(1);
    expect(log.disposed).toBeGreaterThanOrEqual(1);
  });
});

describe("IdbFaceStore", () => {
  it("round-trips detections by asset id in its own database, overwrites, deletes and misses cleanly", async () => {
    const factory = new IDBFactory();
    const store = new IdbFaceStore(factory);
    await store.save(detections());
    expect(await store.get("a1")).toEqual(detections());
    await store.save(detections({ model: "m/two" }));
    expect((await new IdbFaceStore(factory).get("a1"))?.model).toBe("m/two");
    expect((await factory.databases()).map((d) => d.name)).toContain(FACE_DB_NAME);
    await store.delete("a1");
    expect(await store.get("a1")).toBeUndefined();
    expect(await store.get("nope")).toBeUndefined();
  });
});
