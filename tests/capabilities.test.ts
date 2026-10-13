import { describe, expect, it } from "vitest";
import { capabilityIssues, detectCapabilities, probeEncoders, reportCapabilities, type CapabilityEnv } from "#/platform/capabilities";

const modern: CapabilityEnv = {
  VideoDecoder: class {}, VideoEncoder: class {}, VideoFrame: class {}, AudioDecoder: class {}, AudioEncoder: class {},
  OffscreenCanvas: class {}, AudioContext: class {}, OfflineAudioContext: class {}, BroadcastChannel: class {}, Worker: class {},
  indexedDB: {}, createImageBitmap: () => undefined, structuredClone: () => undefined,
  navigator: { storage: { getDirectory: () => undefined }, locks: {} },
  probeCanvas: () => ({ roundRect: true, filter: true }),
};

describe("detectCapabilities", () => {
  it("reports a modern browser as fully capable with no issues", () => {
    const report = reportCapabilities(modern);
    expect(Object.values(report.capabilities).every(Boolean)).toBe(true);
    expect(report.issues).toEqual([]);
    expect(report.level).toBe("full");
  });

  it("reports every capability as missing in an empty environment", () => {
    const capabilities = detectCapabilities({});
    expect(capabilities.videoDecoding).toBe(false);
    expect(capabilities.videoEncoding).toBe(false);
    expect(capabilities.opfs).toBe(false);
    expect(capabilities.webLocks).toBe(false);
    expect(capabilities.indexedDb).toBe(false);
  });

  it("needs both VideoEncoder and VideoFrame to encode video", () => {
    expect(detectCapabilities({ ...modern, VideoFrame: undefined }).videoEncoding).toBe(false);
    expect(detectCapabilities({ ...modern, VideoEncoder: undefined }).videoEncoding).toBe(false);
  });

  it("treats a canvas that ignores ctx.filter as lacking filters", () => {
    expect(detectCapabilities({ ...modern, probeCanvas: () => ({ roundRect: true, filter: false }) }).canvasFilter).toBe(false);
  });

  it("assumes canvas features when there is no DOM to probe", () => {
    const capabilities = detectCapabilities({ ...modern, probeCanvas: () => null });
    expect(capabilities.canvasFilter).toBe(true);
    expect(capabilities.canvasRoundRect).toBe(true);
  });

  it("requires getDirectory, not just navigator.storage, for OPFS", () => {
    expect(detectCapabilities({ ...modern, navigator: { storage: {}, locks: {} } }).opfs).toBe(false);
  });
});

describe("capabilityIssues", () => {
  it("makes missing video decoding an import blocker and sorts blockers first", () => {
    const issues = capabilityIssues(detectCapabilities({ ...modern, VideoDecoder: undefined, navigator: {} }));
    expect(issues[0]).toMatchObject({ id: "videoDecoding", severity: "blocker", scope: "import" });
    expect(issues[0]?.message).toMatch(/can't decode video/);
    expect(issues.map((i) => i.id)).toEqual(expect.arrayContaining(["opfs", "webLocks"]));
    const firstDegraded = issues.findIndex((i) => i.severity === "degraded");
    expect(issues.slice(firstDegraded).every((i) => i.severity === "degraded")).toBe(true);
  });

  it("makes missing video encoding an export-only blocker, so editing stays available", () => {
    const report = reportCapabilities({ ...modern, VideoEncoder: undefined });
    expect(report.issues).toEqual([expect.objectContaining({ id: "videoEncoding", severity: "blocker", scope: "export" })]);
    expect(report.level).toBe("partial");
  });

  it("is unsupported without video decoding or IndexedDB", () => {
    expect(reportCapabilities({ ...modern, VideoDecoder: undefined }).level).toBe("unsupported");
    expect(reportCapabilities({ ...modern, indexedDB: undefined }).level).toBe("unsupported");
  });

  it("describes degraded features without blocking", () => {
    const report = reportCapabilities({ ...modern, AudioEncoder: undefined, probeCanvas: () => ({ roundRect: false, filter: false }) });
    expect(report.issues.map((i) => i.id).sort()).toEqual(["audioEncoding", "canvasFilter", "canvasRoundRect"]);
    expect(report.issues.every((i) => i.severity === "degraded")).toBe(true);
    expect(report.level).toBe("partial");
  });
});

describe("probeEncoders", () => {
  const encoder = (supported: (codec: string, height: number) => boolean) => ({
    isConfigSupported: async (config: { codec: string; height: number }) => ({ supported: supported(config.codec, config.height) }),
  });

  it("picks the first supported codec per container", async () => {
    const result = await probeEncoders({ width: 3840, height: 2160, encoder: encoder((codec) => codec.startsWith("vp09")) });
    expect(result).toEqual({ mp4: true, webm: true, mp4Video: "vp9", webmVideo: "vp9" });
  });

  it("reports containers with no encodable codec at that size", async () => {
    const result = await probeEncoders({ width: 3840, height: 2160, encoder: encoder((codec, height) => codec.startsWith("avc1") && height <= 1080) });
    expect(result).toEqual({ mp4: false, webm: false, mp4Video: null, webmVideo: null });
  });

  it("treats a throwing isConfigSupported as unsupported", async () => {
    const result = await probeEncoders({ width: 640, height: 360, encoder: { isConfigSupported: async () => { throw new TypeError("bad"); } } });
    expect(result.mp4).toBe(false);
  });

  it("reports nothing without a VideoEncoder", async () => {
    const result = await probeEncoders({ width: 640, height: 360, encoder: undefined });
    expect(result.mp4 || result.webm).toBe(false);
  });
});
