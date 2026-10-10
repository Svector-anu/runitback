import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const counters = vi.hoisted(() => ({ inputsOpen: 0, inputsEverOpened: 0, iteratorsOpen: 0, maxInputsOpen: 0, sinkOptions: [] as unknown[] }));

vi.mock("mediabunny", () => {
  class FakeInput {
    constructor() {
      counters.inputsOpen++;
      counters.inputsEverOpened++;
      counters.maxInputsOpen = Math.max(counters.maxInputsOpen, counters.inputsOpen);
    }

    async getPrimaryVideoTrack() {
      return { getDisplayWidth: async () => 3840, getDisplayHeight: async () => 2160 };
    }

    async getPrimaryAudioTrack() {
      return null;
    }

    dispose() {
      counters.inputsOpen--;
    }
  }
  class FakeCanvasSink {
    constructor(_track: unknown, options?: unknown) {
      counters.sinkOptions.push(options);
    }

    async getCanvas(t: number) {
      return { canvas: { width: 1, height: 1 }, timestamp: Math.floor(t), duration: 1 };
    }

    async *canvases(start: number) {
      counters.iteratorsOpen++;
      try {
        for (let t = Math.floor(start); ; t++) yield { canvas: { width: 1, height: 1 }, timestamp: t, duration: 1 };
      } finally {
        counters.iteratorsOpen--;
      }
    }
  }
  return {
    ALL_FORMATS: [], BlobSource: class {}, Input: FakeInput, CanvasSink: FakeCanvasSink, AudioBufferSink: class {},
  };
});

const { MediaRuntime } = await import("#/platform/media-runtime");
const { MAX_OPEN_DECODERS } = await import("#/platform/video-frames");

let urlsCreated = 0;
let urlsRevoked = 0;

beforeEach(() => {
  counters.inputsOpen = 0;
  counters.inputsEverOpened = 0;
  counters.iteratorsOpen = 0;
  counters.maxInputsOpen = 0;
  counters.sinkOptions = [];
  urlsCreated = 0;
  urlsRevoked = 0;
  vi.stubGlobal("URL", { createObjectURL: () => `blob:${++urlsCreated}`, revokeObjectURL: () => { urlsRevoked++; } });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("MediaRuntime resource ownership", () => {
  it("scrubbing a long source keeps one decoder and at most one live iterator", async () => {
    const runtime = new MediaRuntime();
    runtime.setBlob("long", new Blob(["x"]));
    for (let i = 0; i < 400; i++) await runtime.video.getFrame("long", (i * 7919) % 600);
    expect(counters.inputsOpen).toBe(1);
    expect(counters.iteratorsOpen).toBeLessThanOrEqual(1);
    expect(runtime.stats()).toMatchObject({ videoDecoders: 1 });
    await runtime.dispose();
    expect(counters.inputsOpen).toBe(0);
    expect(counters.iteratorsOpen).toBe(0);
  });

  it("caps open decoders across many media and releases evicted ones", async () => {
    const runtime = new MediaRuntime();
    const count = MAX_OPEN_DECODERS * 3;
    for (let i = 0; i < count; i++) runtime.setBlob(`m${i}`, new Blob(["x"]));
    for (let round = 0; round < 3; round++) {
      for (let i = 0; i < count; i++) await runtime.video.getFrame(`m${i}`, round);
    }
    expect(counters.maxInputsOpen).toBeLessThanOrEqual(MAX_OPEN_DECODERS);
    expect(runtime.stats().videoDecoders).toBeLessThanOrEqual(MAX_OPEN_DECODERS);
    await runtime.dispose();
    expect(counters.inputsOpen).toBe(0);
  });

  it("keeps recently used decoders open while evicting the least recently used", async () => {
    const runtime = new MediaRuntime();
    for (let i = 0; i <= MAX_OPEN_DECODERS; i++) runtime.setBlob(`m${i}`, new Blob(["x"]));
    for (let i = 0; i < MAX_OPEN_DECODERS; i++) await runtime.video.getFrame(`m${i}`, 0);
    await runtime.video.getFrame("m0", 1);
    const opened = counters.inputsEverOpened;
    await runtime.video.getFrame(`m${MAX_OPEN_DECODERS}`, 0);
    await runtime.video.getFrame("m0", 2);
    expect(counters.inputsEverOpened).toBe(opened + 1);
    await runtime.dispose();
  });

  it("revokes every object URL it created and drops decoders on release and dispose", async () => {
    const runtime = new MediaRuntime();
    for (const id of ["a", "b", "c"]) {
      runtime.setBlob(id, new Blob(["x"]));
      expect(runtime.objectUrl(id)).not.toBeNull();
      await runtime.video.getFrame(id, 0);
    }
    expect(runtime.stats()).toMatchObject({ blobs: 3, objectUrls: 3, videoDecoders: 3 });
    await runtime.release("a");
    expect(runtime.stats()).toMatchObject({ blobs: 2, objectUrls: 2, videoDecoders: 2 });
    expect(urlsRevoked).toBe(1);
    await runtime.dispose();
    expect(urlsRevoked).toBe(urlsCreated);
    expect(runtime.stats()).toEqual({ blobs: 0, objectUrls: 0, videoDecoders: 0, imageBitmaps: 0 });
    expect(counters.inputsOpen).toBe(0);
  });

  it("decodes preview frames no larger than the preview cap", async () => {
    const runtime = new MediaRuntime();
    runtime.setBlob("uhd", new Blob(["x"]));
    await runtime.video.getFrame("uhd", 0);
    expect(counters.sinkOptions[0]).toMatchObject({ width: 1920, height: 1080, fit: "fill" });
    await runtime.dispose();
  });
});
