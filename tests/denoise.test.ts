import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { denoiseChannels, mixDenoised, resample, type FrameDenoiser } from "#/engine/audio";
import { DenoiseCache, DenoiseTooLongError, denoisedSource, loadRnnoise, type BufferSource } from "#/platform/denoise";
import { rmsDb, speechPlusNoise } from "./speech-fixture";

vi.setConfig({ testTimeout: 120_000 });
const wasmBinary = readFileSync("src/platform/denoise/vendor/rnnoise.wasm");
const runtime = () => loadRnnoise({ wasmBinary: new Uint8Array(wasmBinary) });

describe("resample", () => {
  it("keeps a 1 kHz tone intact across 44.1 kHz -> 48 kHz -> 44.1 kHz (error below -50 dB)", () => {
    const length = 44_100;
    const tone = Float32Array.from({ length }, (_, i) => 0.5 * Math.sin((2 * Math.PI * 1000 * i) / 44_100));
    const up = resample({ samples: tone, fromRate: 44_100, toRate: 48_000 });
    expect(up.length).toBe(48_000);
    const back = resample({ samples: up, fromRate: 48_000, toRate: 44_100 });
    expect(back.length).toBe(length);
    let error = 0;
    let signal = 0;
    for (let i = 2000; i < length - 2000; i++) {
      error += ((back[i] as number) - (tone[i] as number)) ** 2;
      signal += (tone[i] as number) ** 2;
    }
    expect(10 * Math.log10(error / signal)).toBeLessThan(-50);
  });

  it("returns a copy for equal rates and attenuates content above the new Nyquist", () => {
    const x = Float32Array.from({ length: 100 }, (_, i) => i);
    expect(resample({ samples: x, fromRate: 8000, toRate: 8000 })).toEqual(x);
    const high = Float32Array.from({ length: 48_000 }, (_, i) => Math.sin((2 * Math.PI * 20_000 * i) / 48_000));
    const down = resample({ samples: high, fromRate: 48_000, toRate: 16_000 });
    expect(Math.max(...down.subarray(200, down.length - 200).map(Math.abs))).toBeLessThan(0.02);
  });
});

describe("denoiseChannels with the real RNNoise wasm", () => {
  it("cuts the noise floor by at least 15 dB in pauses and keeps speech within 2 dB", async () => {
    const fixture = speechPlusNoise();
    const rn = await runtime();
    const [wet] = await denoiseChannels({ channels: [fixture.mixed], sampleRate: fixture.sampleRate, createDenoiser: () => rn.createDenoiser() });
    const before = rmsDb(fixture.mixed, fixture.sampleRate, fixture.pauses);
    const after = rmsDb(wet as Float32Array, fixture.sampleRate, fixture.pauses);
    const speechBefore = rmsDb(fixture.mixed, fixture.sampleRate, fixture.voiced);
    const speechAfter = rmsDb(wet as Float32Array, fixture.sampleRate, fixture.voiced);
    console.info(`noise floor ${before.toFixed(1)} dB -> ${after.toFixed(1)} dB (${(before - after).toFixed(1)} dB reduction); speech ${speechBefore.toFixed(1)} -> ${speechAfter.toFixed(1)} dB`);
    expect(before - after).toBeGreaterThan(15);
    expect(Math.abs(speechAfter - speechBefore)).toBeLessThan(2);
    expect(wet?.length).toBe(fixture.mixed.length);
  });

  it("is time-aligned with the input (the model's one-frame delay is compensated)", async () => {
    const fixture = speechPlusNoise();
    const rn = await runtime();
    const [wet] = await denoiseChannels({ channels: [fixture.mixed], sampleRate: fixture.sampleRate, createDenoiser: () => rn.createDenoiser() });
    let bestLag = 0;
    let best = -Infinity;
    for (let lag = -240; lag <= 240; lag += 4) {
      let sum = 0;
      for (let i = 24_000; i < 120_000; i += 2) sum += (fixture.clean[i] as number) * ((wet as Float32Array)[i + lag] as number);
      if (sum > best) {
        best = sum;
        bestLag = lag;
      }
    }
    expect(Math.abs(bestLag)).toBeLessThanOrEqual(8);
  });

  it("works at 44.1 kHz and on stereo, with independent state per channel", async () => {
    const fixture = speechPlusNoise({ sampleRate: 44_100, seconds: 4 });
    const rn = await runtime();
    const wet = await denoiseChannels({ channels: [fixture.mixed, fixture.mixed], sampleRate: 44_100, createDenoiser: () => rn.createDenoiser() });
    expect(wet).toHaveLength(2);
    expect(wet[0]).toEqual(wet[1]);
    expect(rmsDb(fixture.mixed, 44_100, fixture.pauses) - rmsDb(wet[0] as Float32Array, 44_100, fixture.pauses)).toBeGreaterThan(15);
  });

  it("reports progress to 1, honours abort, and disposes every denoiser it created", async () => {
    const fixture = speechPlusNoise({ seconds: 2 });
    const rn = await runtime();
    const progress: number[] = [];
    let disposed = 0;
    await denoiseChannels({
      channels: [fixture.mixed], sampleRate: fixture.sampleRate, onProgress: (p) => progress.push(p),
      createDenoiser: () => {
        const d = rn.createDenoiser();
        return { process: (f) => d.process(f), dispose: () => { disposed++; d.dispose(); } } satisfies FrameDenoiser;
      },
    });
    expect(progress.at(-1)).toBe(1);
    expect(progress).toEqual([...progress].sort((a, b) => a - b));
    expect(disposed).toBe(1);
    const controller = new AbortController();
    controller.abort();
    await expect(denoiseChannels({ channels: [fixture.mixed], sampleRate: fixture.sampleRate, signal: controller.signal, createDenoiser: () => rn.createDenoiser() })).rejects.toThrow();
  });

  it("strength mixes dry and wet: 0 is identical, 1 is the wet signal, 0.5 sits between", async () => {
    const fixture = speechPlusNoise({ seconds: 3 });
    const rn = await runtime();
    const [wet] = await denoiseChannels({ channels: [fixture.mixed], sampleRate: fixture.sampleRate, createDenoiser: () => rn.createDenoiser() });
    const at = (strength: number): Float32Array => {
      const out = new Float32Array(fixture.mixed.length);
      mixDenoised({ dry: fixture.mixed, wet: wet as Float32Array, strength, out });
      return out;
    };
    expect(at(0)).toEqual(fixture.mixed);
    expect(at(1)).toEqual(wet);
    const floor = (x: Float32Array): number => rmsDb(x, fixture.sampleRate, fixture.pauses);
    expect(floor(at(0.5))).toBeLessThan(floor(at(0)) - 5);
    expect(floor(at(0.5))).toBeGreaterThan(floor(at(1)));
  });
});

class FakeBuffer {
  readonly numberOfChannels: number;
  readonly length: number;
  readonly duration: number;
  constructor(readonly channels: Float32Array[], readonly sampleRate: number) {
    this.numberOfChannels = channels.length;
    this.length = channels[0]?.length ?? 0;
    this.duration = this.length / sampleRate;
  }
  getChannelData(c: number): Float32Array { return this.channels[c] as Float32Array; }
  copyToChannel(source: Float32Array, c: number): void { (this.channels[c] as Float32Array).set(source); }
}

/** A decoder-like source that hands out the signal in codec-sized slices. */
function sliceSource(samples: Float32Array, sampleRate: number, slice = 1024): BufferSource {
  return {
    async *buffers(start = 0, end = Infinity) {
      for (let i = 0; i < samples.length; i += slice) {
        const ts = i / sampleRate;
        if (ts + slice / sampleRate <= start || ts >= end) continue;
        const buffer = new FakeBuffer([samples.slice(i, i + slice)], sampleRate);
        yield { buffer: buffer as unknown as AudioBuffer, timestamp: ts, duration: buffer.duration };
      }
    },
  };
}

describe("DenoiseCache and denoisedSource", () => {
  const makeBuffer = (o: { length: number; numberOfChannels: number; sampleRate: number }) =>
    new FakeBuffer(Array.from({ length: o.numberOfChannels }, () => new Float32Array(o.length)), o.sampleRate) as unknown as AudioBuffer;

  it("computes once per blob, shares the result, reports status and releases", async () => {
    const fixture = speechPlusNoise({ seconds: 3 });
    const rn = await runtime();
    let created = 0;
    const cache = new DenoiseCache({ runtime: async () => ({ createDenoiser: () => { created++; return rn.createDenoiser(); } }) });
    const blob = new Blob(["x"]);
    const source = sliceSource(fixture.mixed, fixture.sampleRate);
    expect(cache.status(blob).state).toBe("idle");
    const first = cache.ensure(blob, source);
    expect(cache.status(blob).state).toBe("running");
    const audio = await first;
    expect(await cache.ensure(blob, source)).toBe(audio);
    expect(created).toBe(1);
    expect(cache.status(blob).state).toBe("ready");
    expect(cache.peek(blob)).toBe(audio);
    cache.release(blob);
    expect(cache.status(blob).state).toBe("idle");
    expect(cache.peek(blob)).toBeUndefined();
  });

  it("the scheduled buffers carry the measured noise reduction at strength 1 and pass through at 0", async () => {
    const fixture = speechPlusNoise({ seconds: 3 });
    const rn = await runtime();
    const cache = new DenoiseCache({ runtime: async () => rn });
    const base = sliceSource(fixture.mixed, fixture.sampleRate);
    const audio = await cache.ensure(new Blob(["y"]), base);
    const collect = async (strength: number): Promise<Float32Array> => {
      const out = new Float32Array(fixture.mixed.length);
      for await (const w of denoisedSource({ base, audio, strength, makeBuffer }).buffers()) out.set(w.buffer.getChannelData(0), Math.round(w.timestamp * fixture.sampleRate));
      return out;
    };
    expect(await collect(0)).toEqual(fixture.mixed);
    const wet = await collect(1);
    expect(rmsDb(fixture.mixed, fixture.sampleRate, fixture.pauses) - rmsDb(wet, fixture.sampleRate, fixture.pauses)).toBeGreaterThan(15);
  });

  it("rejects audio over the memory cap with a clear error and does not keep a result", async () => {
    const cache = new DenoiseCache({ runtime: async () => runtime() });
    const long: BufferSource = {
      async *buffers() {
        const chunk = new Float32Array(48_000 * 60);
        for (let m = 0; m < 20; m++) yield { buffer: new FakeBuffer([chunk], 48_000) as unknown as AudioBuffer, timestamp: m * 60, duration: 60 };
      },
    };
    const blob = new Blob(["z"]);
    await expect(cache.ensure(blob, long)).rejects.toBeInstanceOf(DenoiseTooLongError);
    expect(cache.status(blob).state).toBe("error");
    expect(cache.peek(blob)).toBeUndefined();
  });
});
