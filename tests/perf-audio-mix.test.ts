import { afterEach, describe, expect, it, vi } from "vitest";
import type { AudioClip } from "#/engine/audio";
import type { AudioSinkCache } from "#/platform/audio-scheduler";
import { MIX_CHUNK_SECONDS, MIX_PREROLL_SECONDS, openAudioMix } from "#/export/audio-mix";

const SAMPLE_RATE = 44100;
const TEN_MINUTES = 600;

/** Bytes of sample storage allocated by mix output buffers (source buffers are shared and excluded). */
const allocation = { bytes: 0 };

class FakeAudioBuffer {
  readonly numberOfChannels: number;
  readonly length: number;
  readonly duration: number;
  private readonly channels: Float32Array[];

  constructor(options: { numberOfChannels: number; length: number; sampleRate: number }) {
    this.numberOfChannels = options.numberOfChannels;
    this.length = options.length;
    this.duration = options.length / options.sampleRate;
    this.channels = Array.from({ length: options.numberOfChannels }, () => new Float32Array(options.length));
    allocation.bytes += options.numberOfChannels * options.length * Float32Array.BYTES_PER_ELEMENT;
  }

  getChannelData(channel: number): Float32Array {
    return this.channels[channel] as Float32Array;
  }

  copyToChannel(source: Float32Array, channel: number): void {
    (this.channels[channel] as Float32Array).set(source);
  }
}

interface ContextLog {
  lengths: number[];
  rendered: number;
}

function stubOfflineAudioContext(): ContextLog {
  const log: ContextLog = { lengths: [], rendered: 0 };
  class FakeOfflineAudioContext {
    currentTime = 0;
    destination = {};

    constructor(private readonly channels: number, private readonly length: number, readonly sampleRate: number) {
      log.lengths.push(length);
    }

    createGain() {
      return { gain: { value: 1, setValueAtTime: () => undefined, linearRampToValueAtTime: () => undefined }, connect: () => undefined, disconnect: () => undefined };
    }

    createDynamicsCompressor() {
      return { threshold: { value: 0 }, knee: { value: 0 }, ratio: { value: 0 }, attack: { value: 0 }, release: { value: 0 }, connect: () => undefined };
    }

    createBufferSource() {
      return { buffer: null, playbackRate: { value: 1 }, connect: () => undefined, disconnect: () => undefined, onended: null, start: () => undefined };
    }

    createBuffer(channels: number, length: number, sampleRate: number): FakeAudioBuffer {
      return new FakeAudioBuffer({ numberOfChannels: channels, length, sampleRate });
    }

    async startRendering(): Promise<FakeAudioBuffer> {
      log.rendered++;
      return new FakeAudioBuffer({ numberOfChannels: this.channels, length: this.length, sampleRate: this.sampleRate });
    }
  }
  vi.stubGlobal("OfflineAudioContext", FakeOfflineAudioContext);
  return log;
}

/** Ten minutes of overlapping one-minute clips, each source second decoded as its own small buffer. */
function tenMinuteClips(): AudioClip[] {
  return Array.from({ length: 14 }, (_, i): AudioClip => ({
    key: `c${i}`, mediaId: "m", start: i * 45, duration: 60, trimStart: 0, rate: 1, maintainPitch: false,
    gainAt: () => 1, animated: false, constantGain: 1,
  }));
}

function syntheticSinks(): AudioSinkCache {
  const second = new FakeAudioBuffer({ numberOfChannels: 2, length: SAMPLE_RATE, sampleRate: SAMPLE_RATE });
  const sink = {
    buffers: async function* buffers(start: number, end: number) {
      for (let t = Math.floor(start); t < end; t++) yield { timestamp: t, duration: 1, buffer: second };
    },
  };
  return { get: () => Promise.resolve(sink) } as unknown as AudioSinkCache;
}

async function drain(input: { chunkSeconds?: number }): Promise<{ chunks: number; samples: number; largestChunk: number; peakBytesPerChunkMb: number }> {
  const mix = await openAudioMix({ clips: tenMinuteClips(), durationSeconds: TEN_MINUTES, sinks: syntheticSinks(), sampleRate: SAMPLE_RATE, ...input });
  if (!mix) throw new Error("expected a mix");
  let chunks = 0;
  let samples = 0;
  let largestChunk = 0;
  let peakBytes = 0;
  while (true) {
    const before = allocation.bytes;
    const next = await mix.chunks.next();
    if (next.done) break;
    peakBytes = Math.max(peakBytes, allocation.bytes - before);
    chunks++;
    samples += next.value.length;
    largestChunk = Math.max(largestChunk, next.value.length);
  }
  return { chunks, samples, largestChunk, peakBytesPerChunkMb: Math.round(peakBytes / 1e5) / 10 };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("chunked export audio mix", () => {
  it("renders a 10-minute project in bounded chunks that tile the whole timeline", async () => {
    const log = stubOfflineAudioContext();
    const result = await drain({});
    const expectedSamples = TEN_MINUTES * SAMPLE_RATE;
    expect(result.samples).toBe(expectedSamples);
    expect(result.chunks).toBe(Math.ceil(TEN_MINUTES / MIX_CHUNK_SECONDS));
    expect(result.largestChunk).toBe(MIX_CHUNK_SECONDS * SAMPLE_RATE);
    const largestContext = Math.max(...log.lengths);
    expect(largestContext).toBeLessThanOrEqual((MIX_CHUNK_SECONDS + MIX_PREROLL_SECONDS) * SAMPLE_RATE);
    expect(log.lengths).toHaveLength(result.chunks);
  });

  it("renders lazily: nothing is rendered until a chunk is pulled", async () => {
    const log = stubOfflineAudioContext();
    const mix = await openAudioMix({ clips: tenMinuteClips(), durationSeconds: TEN_MINUTES, sinks: syntheticSinks(), sampleRate: SAMPLE_RATE });
    expect(log.rendered).toBe(0);
    await mix!.chunks.next();
    expect(log.rendered).toBe(1);
    await mix!.chunks.return(undefined);
  });

  it("peak buffer memory does not scale with project length (measured against one whole-timeline render)", async () => {
    stubOfflineAudioContext();
    const whole = await drain({ chunkSeconds: TEN_MINUTES });
    vi.unstubAllGlobals();
    stubOfflineAudioContext();
    const chunked = await drain({});
    process.stdout.write(`[perf] audio-mix-10min ${JSON.stringify({ wholeTimeline: whole, chunked })}\n`);
    expect(whole.largestChunk).toBe(TEN_MINUTES * SAMPLE_RATE);
    expect(chunked.largestChunk).toBeLessThan(whole.largestChunk / 30);
    expect(chunked.peakBytesPerChunkMb).toBeLessThan(whole.peakBytesPerChunkMb / 15);
  });

  it("stops rendering when the export is aborted", async () => {
    stubOfflineAudioContext();
    const controller = new AbortController();
    const mix = await openAudioMix({ clips: tenMinuteClips(), durationSeconds: TEN_MINUTES, sinks: syntheticSinks(), sampleRate: SAMPLE_RATE, signal: controller.signal });
    await mix!.chunks.next();
    controller.abort();
    await expect(mix!.chunks.next()).rejects.toThrow();
  });
});
