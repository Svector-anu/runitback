import { describe, expect, it, vi } from "vitest";
import type { AudioClip } from "#/engine/audio";
import { collectAudioClips } from "#/engine/audio";
import { PARAM, type MediaAssetInfo } from "#/engine/model";
import { AudioSinkCache } from "#/platform/audio-scheduler";
import { DenoiseCache, type BufferSource } from "#/platform/denoise";
import { audio, sec, tracksWith, video } from "./helpers";

class FakeBuffer {
  readonly numberOfChannels = 1;
  readonly length: number;
  readonly duration: number;
  constructor(readonly data: Float32Array, readonly sampleRate: number) {
    this.length = data.length;
    this.duration = data.length / sampleRate;
  }
  getChannelData(): Float32Array { return this.data; }
  copyToChannel(source: Float32Array): void { this.data.set(source); }
}

const RATE = 48_000;

vi.stubGlobal("AudioBuffer", class extends FakeBuffer {
  constructor(options: { length: number; numberOfChannels: number; sampleRate: number }) {
    super(new Float32Array(options.length), options.sampleRate);
  }
});
const source = (): BufferSource => ({
  async *buffers() {
    yield { buffer: new FakeBuffer(new Float32Array(RATE).fill(0.5), RATE) as unknown as AudioBuffer, timestamp: 0, duration: 1 };
  },
});

const clip = (denoise: number): AudioClip => ({
  key: "c", mediaId: "m", start: 0, duration: 1, trimStart: 0, rate: 1, maintainPitch: false, gainAt: () => 1, animated: false, constantGain: 1, denoise,
});

/** A "denoiser" that zeroes everything, so wet and dry are trivially distinguishable. */
const silencing = () => ({ createDenoiser: () => ({ process: (f: Float32Array) => new Float32Array(f.length), dispose: () => undefined }) });

async function firstSample(src: BufferSource | null): Promise<number> {
  for await (const w of (src as BufferSource).buffers()) return w.buffer.getChannelData(0)[100] as number;
  throw new Error("no buffers");
}

function cacheWith(denoise: DenoiseCache, releasesDenoise = true) {
  const blob = new Blob(["x"]);
  const sinks = new AudioSinkCache(() => blob, { denoise, releasesDenoise });
  vi.spyOn(sinks, "get").mockResolvedValue(source() as never);
  return { sinks, blob };
}

describe("AudioSinkCache.forClip: the one path live playback and export both take", () => {
  it("returns the original audio for a clip without noise removal, and never starts any work", async () => {
    const denoise = new DenoiseCache({ runtime: async () => silencing() });
    const { sinks, blob } = cacheWith(denoise);
    expect(await firstSample(await sinks.forClip(clip(0)))).toBe(0.5);
    expect(denoise.status(blob).state).toBe("idle");
  });

  it("export (wait) returns the cleaned audio; live playback (no wait) plays the original until it is ready, then switches", async () => {
    const denoise = new DenoiseCache({ runtime: async () => silencing() });
    const { sinks, blob } = cacheWith(denoise);
    expect(await firstSample(await sinks.forClip(clip(1), { wait: false }))).toBe(0.5);
    await denoise.ensure(blob, source());
    const wet = await sinks.forClip(clip(1), { wait: false });
    const exported = await sinks.forClip(clip(1));
    expect(Math.abs(await firstSample(wet))).toBeLessThan(1e-3);
    expect(await firstSample(exported)).toBe(await firstSample(wet));
  });

  it("falls back to the original audio when denoising fails, so an export is never silent", async () => {
    const denoise = new DenoiseCache({ runtime: async () => { throw new Error("wasm failed"); } });
    const { sinks, blob } = cacheWith(denoise);
    expect(await firstSample(await sinks.forClip(clip(1)))).toBe(0.5);
    expect(denoise.status(blob).state).toBe("error");
    expect(await firstSample(await sinks.forClip(clip(1), { wait: false }))).toBe(0.5);
  });

  it("a short-lived cache (the exporter's) leaves the shared result alone when it is disposed", async () => {
    const denoise = new DenoiseCache({ runtime: async () => silencing() });
    const { sinks, blob } = cacheWith(denoise, false);
    await sinks.forClip(clip(1));
    await sinks.release("m");
    expect(denoise.status(blob).state).toBe("ready");
  });

  it("releases the cached result with the media when it owns the media", async () => {
    const denoise = new DenoiseCache({ runtime: async () => silencing() });
    const { sinks, blob } = cacheWith(denoise);
    await sinks.forClip(clip(1));
    expect(denoise.status(blob).state).toBe("ready");
    await sinks.release("m");
    expect(denoise.status(blob).state).toBe("idle");
  });
});

describe("collectAudioClips carries the noise-removal strength", () => {
  const assets: MediaAssetInfo[] = [{ id: "asset-v", name: "v", type: "video", size: 1, lastModified: 0, duration: sec(5), hasAudio: true }];

  it("reads the denoise param from audio and video clips, defaults to 0 and clamps to 0..1", () => {
    const tracks = tracksWith({
      main: [{ ...video("v", 0, 5), params: { ...video("v", 0, 5).params, [PARAM.denoise]: 0.4 } }],
      audio: [{ id: "a1", elements: [{ ...audio("a", 0, 3), params: { ...audio("a", 0, 3).params, [PARAM.denoise]: 7 } }, audio("b", 3, 2)] }],
    });
    const clips = collectAudioClips({ tracks, assets: [...assets, { id: "asset-a", name: "a", type: "audio", size: 1, lastModified: 0, duration: sec(3) }] });
    const strengths = Object.fromEntries(clips.map((c) => [c.key.split("/")[1], c.denoise]));
    expect(strengths).toEqual({ v: 0.4, a: 1, b: 0 });
  });
});
