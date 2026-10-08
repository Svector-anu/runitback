import { afterEach, describe, expect, it, vi } from "vitest";
import { VISUAL_INDEX_VERSION } from "#/engine/visual";
import {
  FRAME_BATCH_SIZE, createClipEngine, createClipIndexer, createClipSearcher, createLoadProgress, isClipModelCached, normalizeRows,
  type ClipBackend, type FrameSource, type ImagePixels,
} from "#/platform/visual";

const pixels = (shade: number): ImagePixels => ({ width: 1, height: 1, data: new Uint8ClampedArray([shade, shade, shade, 255]) });

interface Log { embedCalls: number[]; disposed: number; frameRequests: number[]; framesDisposed: number }

function fakes(options: { missingFrames?: number[]; abort?: AbortController; dimensions?: number } = {}) {
  const log: Log = { embedCalls: [], disposed: 0, frameRequests: [], framesDisposed: 0 };
  const dimensions = options.dimensions ?? 3;
  const backend: ClipBackend = {
    async embedImages({ images, onLoad }) {
      onLoad?.(0.5);
      log.embedCalls.push(images.length);
      options.abort?.abort();
      return images.map((image) => Float32Array.from({ length: dimensions }, (_, d) => (d === 0 ? image.data[0] ?? 0 : 1)));
    },
    async embedTexts({ texts }) { return texts.map(() => new Float32Array(dimensions)); },
    dispose() { log.disposed++; },
  };
  const frames: FrameSource = {
    async frameAt(seconds) {
      log.frameRequests.push(seconds);
      return options.missingFrames?.includes(seconds) ? null : pixels(Math.round(seconds * 10));
    },
    async dispose() { log.framesDisposed++; },
  };
  return { log, backend, frames };
}

describe("createClipIndexer with a fake backend", () => {
  it("samples frames in ascending order, embeds them in batches and returns versioned embeddings with the model id", async () => {
    const { log, backend, frames } = fakes();
    const indexer = createClipIndexer({
      getVideo: () => new Blob(), getFootage: async () => ({ durationSeconds: 40, cutTimes: [10, 20] }),
      model: "m/clip", intervalSeconds: 2, createBackend: () => backend, openFrames: () => frames,
    });
    const progress: number[] = [];
    const result = await indexer.index({ assetId: "a1", onProgress: (f) => progress.push(f) });
    expect(result.version).toBe(VISUAL_INDEX_VERSION);
    expect(result.model).toBe("m/clip");
    expect(result.dimensions).toBe(3);
    expect(result.cuts).toEqual([10, 20]);
    expect(result.durationSeconds).toBe(40);
    expect(result.vectors).toHaveLength(result.times.length * 3);
    expect(result.times).toEqual(log.frameRequests);
    expect([...result.times].sort((a, b) => a - b)).toEqual(result.times);
    expect(result.times).toContain(5);
    expect(log.embedCalls.every((n) => n <= FRAME_BATCH_SIZE)).toBe(true);
    expect(log.embedCalls.reduce((a, b) => a + b, 0)).toBe(result.times.length);
    expect([...progress].sort((a, b) => a - b)).toEqual(progress);
    expect(progress[progress.length - 1]).toBe(1);
    expect(log.disposed).toBe(1);
    expect(log.framesDisposed).toBe(1);
  });

  it("caps the number of frames", async () => {
    const { log, backend, frames } = fakes();
    const indexer = createClipIndexer({
      getVideo: () => new Blob(), getFootage: async () => ({ durationSeconds: 600, cutTimes: [] }), maxFrames: 12, createBackend: () => backend, openFrames: () => frames,
    });
    const result = await indexer.index({ assetId: "a1" });
    expect(result.times).toHaveLength(12);
    expect(log.frameRequests).toHaveLength(12);
  });

  it("skips frames that cannot be decoded and keeps times and vectors aligned", async () => {
    const { backend, frames } = fakes({ missingFrames: [1] });
    const indexer = createClipIndexer({
      getVideo: () => new Blob(), getFootage: async () => ({ durationSeconds: 6, cutTimes: [] }), intervalSeconds: 2, createBackend: () => backend, openFrames: () => frames,
    });
    const result = await indexer.index({ assetId: "a1" });
    expect(result.times).not.toContain(1);
    expect(result.vectors).toHaveLength(result.times.length * result.dimensions);
    expect(result.vectors[0]).toBeCloseTo((result.times[0] as number) * 10, 5);
  });

  it("fails clearly when no frame decodes, the media is unknown, or the video is empty", async () => {
    const empty = fakes({ missingFrames: [1, 2, 3, 5] });
    const none = createClipIndexer({ getVideo: () => new Blob(), getFootage: async () => ({ durationSeconds: 6, cutTimes: [] }), createBackend: () => empty.backend, openFrames: () => empty.frames });
    await expect(none.index({ assetId: "a1" })).rejects.toThrow(/no video frames/);
    expect(empty.log.disposed).toBe(1);
    const unknown = createClipIndexer({ getVideo: () => undefined, getFootage: async () => ({ durationSeconds: 6, cutTimes: [] }) });
    await expect(unknown.index({ assetId: "zzz" })).rejects.toThrow(/not loaded/);
    const zero = createClipIndexer({ getVideo: () => new Blob(), getFootage: async () => ({ durationSeconds: 0, cutTimes: [] }) });
    await expect(zero.index({ assetId: "a1" })).rejects.toThrow(/no video frames/);
  });

  it("stops and releases the worker and the decoder when aborted", async () => {
    const controller = new AbortController();
    const { log, backend, frames } = fakes({ abort: controller });
    const indexer = createClipIndexer({
      getVideo: () => new Blob(), getFootage: async () => ({ durationSeconds: 120, cutTimes: [] }), createBackend: () => backend, openFrames: () => frames,
    });
    await expect(indexer.index({ assetId: "a1", signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(log.embedCalls).toHaveLength(1);
    expect(log.disposed).toBeGreaterThanOrEqual(1);
    expect(log.framesDisposed).toBe(1);
  });

  it("does nothing when already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const { log, backend, frames } = fakes();
    const indexer = createClipIndexer({ getVideo: () => new Blob(), getFootage: async () => ({ durationSeconds: 6, cutTimes: [] }), createBackend: () => backend, openFrames: () => frames });
    await expect(indexer.index({ assetId: "a1", signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(log.frameRequests).toEqual([]);
  });
});

describe("createClipSearcher", () => {
  afterEach(() => vi.useRealTimers());

  function counting() {
    const state = { created: 0, disposed: 0, texts: [] as string[] };
    const create = (): ClipBackend => {
      state.created++;
      return {
        async embedImages() { return []; },
        async embedTexts({ texts }) { state.texts.push(...texts); return texts.map(() => Float32Array.from([1, 0])); },
        dispose() { state.disposed++; },
      };
    };
    return { state, create };
  }

  it("reuses one worker across queries and terminates it once idle", async () => {
    vi.useFakeTimers();
    const { state, create } = counting();
    const searcher = createClipSearcher({ model: "m", idleMs: 1000, createBackend: create });
    expect(searcher.model).toBe("m");
    await searcher.embedText("a dog");
    await searcher.embedText("a cat");
    expect(state.created).toBe(1);
    await vi.advanceTimersByTimeAsync(999);
    expect(state.disposed).toBe(0);
    await vi.advanceTimersByTimeAsync(2);
    expect(state.disposed).toBe(1);
    await searcher.embedText("again");
    expect(state.created).toBe(2);
    expect(state.texts).toEqual(["a dog", "a cat", "again"]);
  });

  it("drops the worker when the model fails so the next query starts fresh", async () => {
    let calls = 0;
    const searcher = createClipSearcher({
      createBackend: () => ({
        async embedImages() { return []; },
        async embedTexts() { calls++; if (calls === 1) throw new Error("boom"); return [Float32Array.from([1])]; },
        dispose() {},
      }),
    });
    await expect(searcher.embedText("x")).rejects.toThrow("boom");
    expect(await searcher.embedText("x")).toEqual(Float32Array.from([1]));
    searcher.dispose();
  });
});

describe("clip engine", () => {
  const encoder = (log: string[], name: string) => async (items: unknown[]) => {
    log.push(`${name}:${items.length}`);
    return { data: Float32Array.from(items.flatMap(() => [3, 4])), dimensions: 2 };
  };

  it("L2-normalises every row", () => {
    const rows = normalizeRows({ data: Float32Array.from([3, 4, 0, 5]), dimensions: 2 });
    expect(rows.map((r) => Array.from(r).map((v) => Math.round(v * 100) / 100))).toEqual([[0.6, 0.8], [0, 1]]);
  });

  it("loads each encoder once per model, even for concurrent first calls, and reports instant load afterwards", async () => {
    const loads: string[] = [];
    const log: string[] = [];
    const engine = createClipEngine({
      async loadImageEncoder(model) { loads.push(`image:${model}`); return encoder(log, "image") as never; },
      async loadTextEncoder(model) { loads.push(`text:${model}`); return encoder(log, "text") as never; },
    });
    const [a, b] = await Promise.all([engine.embedImages({ model: "m", images: [pixels(1)] }), engine.embedImages({ model: "m", images: [pixels(2), pixels(3)] })]);
    expect(a.dimensions).toBe(2);
    expect(b.data).toHaveLength(4);
    expect(Math.hypot(a.data[0] as number, a.data[1] as number)).toBeCloseTo(1, 5);
    const fractions: number[] = [];
    await engine.embedTexts({ model: "m", texts: ["a"], onLoad: (f) => fractions.push(f) });
    await engine.embedTexts({ model: "m", texts: ["b"], onLoad: (f) => fractions.push(f) });
    expect(loads).toEqual(["image:m", "text:m"]);
    expect(fractions.at(-1)).toBe(1);
  });

  it("retries loading after a failed load", async () => {
    let attempts = 0;
    const engine = createClipEngine({
      async loadImageEncoder() { attempts++; if (attempts === 1) throw new Error("network"); return encoder([], "image") as never; },
      async loadTextEncoder() { throw new Error("unused"); },
    });
    await expect(engine.embedImages({ model: "m", images: [pixels(1)] })).rejects.toThrow("network");
    await expect(engine.embedImages({ model: "m", images: [pixels(1)] })).resolves.toBeDefined();
    expect(attempts).toBe(2);
  });

  it("folds per-file download events into one fraction that never goes backwards", () => {
    const seen: number[] = [];
    const onEvent = createLoadProgress((f) => seen.push(f));
    onEvent({ status: "initiate", file: "a" });
    onEvent({ status: "progress", file: "a", loaded: 50, total: 100 });
    onEvent({ status: "progress", file: "b", loaded: 0, total: 300 });
    onEvent({ status: "progress", file: "b", loaded: 150, total: 300 });
    onEvent({ status: "done", file: "a" });
    onEvent({ status: "done", file: "b" });
    onEvent("garbage");
    expect([...seen].sort((x, y) => x - y)).toEqual(seen);
    expect(seen[0]).toBeCloseTo(0.5, 5);
    expect(seen.at(-1)).toBe(1);
  });
});

describe("isClipModelCached", () => {
  const stubCaches = (urls: string[] | null): void => {
    vi.stubGlobal("caches", {
      has: async () => urls !== null,
      open: async () => ({ keys: async () => (urls ?? []).map((url) => ({ url })) }),
    });
  };
  afterEach(() => vi.unstubAllGlobals());
  const file = (model: string, name: string): string => `https://huggingface.co/${model}/resolve/main/onnx/${name}`;

  it("is true only when both the image half and the text half are present for that model", async () => {
    stubCaches([file("Xenova/clip", "vision_model_quantized.onnx"), file("Xenova/clip", "text_model_quantized.onnx")]);
    expect(await isClipModelCached("Xenova/clip")).toBe(true);
    expect(await isClipModelCached("Xenova/other")).toBe(false);
    stubCaches([file("Xenova/clip", "vision_model_quantized.onnx"), file("Xenova/clip", "model_quantized.onnx")]);
    expect(await isClipModelCached("Xenova/clip")).toBe(false);
  });

  it("is false without a cache", async () => {
    stubCaches(null);
    expect(await isClipModelCached("Xenova/clip")).toBe(false);
  });
});
