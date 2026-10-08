import { afterEach, describe, expect, it, vi } from "vitest";
import type { AudioClip } from "#/engine/audio";
import type { AudioSinkCache } from "#/platform/audio-scheduler";
import { mixTimelineAudio } from "#/export/audio-mix";

function sineWave(frequency: number, sampleRate: number, seconds: number): Float32Array {
  const length = Math.round(sampleRate * seconds);
  const out = new Float32Array(length);
  for (let i = 0; i < length; i++) out[i] = Math.sin((2 * Math.PI * frequency * i) / sampleRate);
  return out;
}

/** Autocorrelation pitch estimate — mirrors tests/audio-stretch.test.ts and tests/audio-scheduler.test.ts. */
function estimateFrequency(signal: Float32Array, sampleRate: number, minFreq = 80, maxFreq = 1000): number {
  const minLag = Math.max(1, Math.floor(sampleRate / maxFreq));
  const maxLag = Math.min(signal.length - 1, Math.ceil(sampleRate / minFreq));
  let bestLag = minLag;
  let bestScore = -Infinity;
  for (let lag = minLag; lag <= maxLag; lag++) {
    let sum = 0;
    for (let i = 0; i < signal.length - lag; i++) sum += (signal[i] ?? 0) * (signal[i + lag] ?? 0);
    if (sum > bestScore) {
      bestScore = sum;
      bestLag = lag;
    }
  }
  return sampleRate / bestLag;
}

class FakeAudioBuffer {
  readonly numberOfChannels: number;
  readonly length: number;
  readonly duration: number;

  constructor(private readonly channels: Float32Array[], readonly sampleRate: number) {
    this.numberOfChannels = channels.length;
    this.length = channels[0]?.length ?? 0;
    this.duration = this.length / sampleRate;
  }

  getChannelData(channel: number): Float32Array {
    return this.channels[channel] as Float32Array;
  }

  copyToChannel(source: Float32Array, channel: number): void {
    (this.channels[channel] as Float32Array).set(source);
  }
}

type FakeSourceNode = { buffer: FakeAudioBuffer | null; playbackRate: { value: number }; startArgs: number[] | null };

/**
 * Node's vitest environment is "node" — no real Web Audio API — so OfflineAudioContext is stubbed the
 * same way tests/audio-scheduler.test.ts stubs BaseAudioContext: capture the nodes `mixTimelineAudio`
 * builds and assert on their buffer/playbackRate/start args directly, rather than simulating DSP mixing.
 */
function stubOfflineAudioContext(): { nodes: FakeSourceNode[] } {
  const nodes: FakeSourceNode[] = [];
  class FakeOfflineAudioContext {
    currentTime = 0;
    destination = {};
    sampleRate: number;

    constructor(_numberOfChannels: number, _length: number, sampleRate: number) {
      this.sampleRate = sampleRate;
    }

    createGain() {
      return { gain: { setValueAtTime: () => undefined, linearRampToValueAtTime: () => undefined }, connect: () => undefined };
    }

    createDynamicsCompressor() {
      return {
        threshold: { value: 0 }, knee: { value: 0 }, ratio: { value: 0 }, attack: { value: 0 }, release: { value: 0 },
        connect: () => undefined,
      };
    }

    createBufferSource(): FakeSourceNode & { connect: () => void; disconnect: () => void; onended: (() => void) | null; start: (...args: number[]) => void } {
      const node = {
        buffer: null as FakeAudioBuffer | null,
        playbackRate: { value: 1 },
        connect: () => undefined,
        disconnect: () => undefined,
        onended: null as (() => void) | null,
        startArgs: null as number[] | null,
        start(...args: number[]) {
          node.startArgs = args;
        },
      };
      nodes.push(node);
      return node;
    }

    createBuffer(numberOfChannels: number, length: number, sampleRate: number): FakeAudioBuffer {
      return new FakeAudioBuffer(Array.from({ length: numberOfChannels }, () => new Float32Array(length)), sampleRate);
    }

    async startRendering(): Promise<FakeAudioBuffer> {
      return new FakeAudioBuffer([new Float32Array(1)], this.sampleRate);
    }
  }
  vi.stubGlobal("OfflineAudioContext", FakeOfflineAudioContext);
  return { nodes };
}

function makeClip(overrides: Partial<AudioClip> = {}): AudioClip {
  return {
    key: "clip", mediaId: "media", start: 0, duration: 0.5, trimStart: 0, rate: 2, maintainPitch: false,
    gainAt: () => 1, animated: false, constantGain: 1,
    ...overrides,
  };
}

function sinkCache(mediaId: string, buffer: FakeAudioBuffer): AudioSinkCache {
  return {
    get: (id: string) =>
      Promise.resolve(id === mediaId ? { buffers: async function* buffers() { yield { timestamp: 0, duration: buffer.duration, buffer }; } } : null),
  } as unknown as AudioSinkCache;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("mixTimelineAudio — pitch preservation", () => {
  const sampleRate = 44100;

  it("maintainPitch=true, rate!=1: export is stretched and pitch-preserved, same as live playback", async () => {
    const { nodes } = stubOfflineAudioContext();
    const source = new FakeAudioBuffer([sineWave(440, sampleRate, 1)], sampleRate);
    const clip = makeClip({ rate: 2, duration: 0.5, maintainPitch: true });

    const result = await mixTimelineAudio({
      clips: [clip], durationSeconds: 0.5, sinks: sinkCache(clip.mediaId, source), sampleRate,
    });

    expect(result).not.toBeNull();
    expect(nodes).toHaveLength(1);
    const node = nodes[0]!;
    expect(node.playbackRate.value).toBe(1);
    expect(node.buffer).not.toBe(source);
    expect(node.buffer!.length).toBe(Math.round(source.length / 2));

    const middle = node.buffer!.getChannelData(0).subarray(Math.floor(node.buffer!.length * 0.2), Math.floor(node.buffer!.length * 0.8));
    const frequency = estimateFrequency(middle, sampleRate);
    expect(frequency).toBeGreaterThan(440 * 0.98);
    expect(frequency).toBeLessThan(440 * 1.02);
  });

  it("maintainPitch=false: regression guard — export keeps the resample/pitch-shift path unchanged", async () => {
    const { nodes } = stubOfflineAudioContext();
    const source = new FakeAudioBuffer([sineWave(440, sampleRate, 1)], sampleRate);
    const clip = makeClip({ rate: 2, duration: 0.5, maintainPitch: false });

    const result = await mixTimelineAudio({
      clips: [clip], durationSeconds: 0.5, sinks: sinkCache(clip.mediaId, source), sampleRate,
    });

    expect(result).not.toBeNull();
    expect(nodes).toHaveLength(1);
    const node = nodes[0]!;
    expect(node.playbackRate.value).toBe(2);
    expect(node.buffer).toBe(source);

    const frequency = estimateFrequency(source.getChannelData(0), sampleRate);
    expect(frequency).toBeGreaterThan(440 * 0.98);
    expect(frequency).toBeLessThan(440 * 1.02);
  });

  it("timeline sync: a clip starting mid-timeline schedules at the same offline-context time, stretched or not", async () => {
    const { nodes } = stubOfflineAudioContext();
    const source = new FakeAudioBuffer([sineWave(440, sampleRate, 1)], sampleRate);
    const clip = makeClip({ start: 0.2, duration: 0.5, rate: 2, maintainPitch: true });

    await mixTimelineAudio({
      clips: [clip], durationSeconds: 0.7, sinks: sinkCache(clip.mediaId, source), sampleRate,
    });

    expect(nodes).toHaveLength(1);
    expect(nodes[0]!.startArgs).toEqual([0.2]);
  });
});
