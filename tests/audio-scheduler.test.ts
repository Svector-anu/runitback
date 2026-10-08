import { describe, expect, it } from "vitest";
import type { AudioClip } from "#/engine/audio";
import { createClipGain, scheduleClipWindow } from "#/platform/audio-scheduler";

function sineWave(frequency: number, sampleRate: number, seconds: number): Float32Array {
  const length = Math.round(sampleRate * seconds);
  const out = new Float32Array(length);
  for (let i = 0; i < length; i++) out[i] = Math.sin((2 * Math.PI * frequency * i) / sampleRate);
  return out;
}

/** Autocorrelation pitch estimate — mirrors tests/audio-stretch.test.ts; verifies perceived pitch, not shipped code. */
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

function fakeCtx(): { ctx: never; nodes: Array<{ buffer: FakeAudioBuffer | null; playbackRate: { value: number }; startArgs: number[] | null }> } {
  const nodes: Array<{ buffer: FakeAudioBuffer | null; playbackRate: { value: number }; startArgs: number[] | null }> = [];
  const ctx = {
    currentTime: 0,
    createGain: () => ({ gain: { setValueAtTime: () => undefined, linearRampToValueAtTime: () => undefined }, connect: () => undefined }),
    createBufferSource: () => {
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
    },
    createBuffer: (numberOfChannels: number, length: number, sampleRate: number) =>
      new FakeAudioBuffer(Array.from({ length: numberOfChannels }, () => new Float32Array(length)), sampleRate),
  };
  return { ctx: ctx as never, nodes };
}

function makeClip(overrides: Partial<AudioClip> = {}): AudioClip {
  return {
    key: "clip", mediaId: "media", start: 0, duration: 0.5, trimStart: 0, rate: 2, maintainPitch: false,
    gainAt: () => 1, animated: false, constantGain: 1,
    ...overrides,
  };
}

function fakeSink(buffer: FakeAudioBuffer, timestamp = 0): { buffers: (start: number, end: number) => AsyncGenerator<{ timestamp: number; duration: number; buffer: FakeAudioBuffer }> } {
  return {
    async *buffers() {
      yield { timestamp, duration: buffer.duration, buffer };
    },
  };
}

function chunkedSink(source: FakeAudioBuffer, chunkSeconds: number): { buffers: () => AsyncGenerator<{ timestamp: number; duration: number; buffer: FakeAudioBuffer }> } {
  return {
    async *buffers() {
      const step = Math.round(chunkSeconds * source.sampleRate);
      for (let at = 0; at < source.length; at += step) {
        const data = source.getChannelData(0).slice(at, at + step);
        const buffer = new FakeAudioBuffer([data], source.sampleRate);
        yield { timestamp: at / source.sampleRate, duration: buffer.duration, buffer };
      }
    },
  };
}

describe("scheduleClipWindow — maintainPitch", () => {
  const sampleRate = 44100;

  it("rate != 1 and maintainPitch: stretches the buffer and plays it back at playbackRate 1 with pitch intact", async () => {
    const { ctx, nodes } = fakeCtx();
    const source = new FakeAudioBuffer([sineWave(440, sampleRate, 1)], sampleRate);
    const clip = makeClip({ rate: 2, duration: 0.5, maintainPitch: true });
    const scheduled = createClipGain(ctx, {} as never);

    await scheduleClipWindow({
      ctx, scheduled, clip, sink: fakeSink(source) as never, from: 0, to: 0.5, toContext: (t) => t,
    });

    expect(nodes).toHaveLength(1);
    const node = nodes[0]!;
    expect(node.playbackRate.value).toBe(1);
    expect(node.startArgs).toEqual([0]);
    expect(node.buffer).not.toBe(source);
    expect(node.buffer!.length).toBe(Math.round(source.length / 2));

    const middle = node.buffer!.getChannelData(0).subarray(Math.floor(node.buffer!.length * 0.2), Math.floor(node.buffer!.length * 0.8));
    const frequency = estimateFrequency(middle, sampleRate);
    expect(frequency).toBeGreaterThan(440 * 0.98);
    expect(frequency).toBeLessThan(440 * 1.02);
  });

  it("maintainPitch=false: regression guard — unchanged playbackRate-driven behavior", async () => {
    const { ctx, nodes } = fakeCtx();
    const source = new FakeAudioBuffer([sineWave(440, sampleRate, 1)], sampleRate);
    const clip = makeClip({ rate: 2, duration: 0.5, maintainPitch: false });
    const scheduled = createClipGain(ctx, {} as never);

    await scheduleClipWindow({
      ctx, scheduled, clip, sink: fakeSink(source) as never, from: 0, to: 0.5, toContext: (t) => t,
    });

    expect(nodes).toHaveLength(1);
    const node = nodes[0]!;
    expect(node.playbackRate.value).toBe(2);
    expect(node.buffer).toBe(source);
    expect(node.startArgs).toEqual([0, 0, 1]);
  });

  it("rate=1 with maintainPitch=true: no stretch needed, same pass-through as maintainPitch=false", async () => {
    const { ctx, nodes } = fakeCtx();
    const source = new FakeAudioBuffer([sineWave(440, sampleRate, 1)], sampleRate);
    const clip = makeClip({ rate: 1, duration: 1, maintainPitch: true });
    const scheduled = createClipGain(ctx, {} as never);

    await scheduleClipWindow({
      ctx, scheduled, clip, sink: fakeSink(source) as never, from: 0, to: 1, toContext: (t) => t,
    });

    expect(nodes).toHaveLength(1);
    const node = nodes[0]!;
    expect(node.playbackRate.value).toBe(1);
    expect(node.buffer).toBe(source);
    expect(node.startArgs).toEqual([0, 0, 1]);
  });

  it("codec-frame-sized chunks are stretched as one continuous signal: one node, pitch intact across chunk boundaries", async () => {
    const { ctx, nodes } = fakeCtx();
    const source = new FakeAudioBuffer([sineWave(440, sampleRate, 1)], sampleRate);
    const clip = makeClip({ rate: 2, duration: 0.5, maintainPitch: true });
    const scheduled = createClipGain(ctx, {} as never);

    await scheduleClipWindow({
      ctx, scheduled, clip, sink: chunkedSink(source, 0.02) as never, from: 0, to: 0.5, toContext: (t) => t,
    });

    expect(nodes).toHaveLength(1);
    const buffer = nodes[0]!.buffer!;
    expect(buffer.length).toBe(Math.round(source.length / 2));
    const middle = buffer.getChannelData(0).subarray(Math.floor(buffer.length * 0.2), Math.floor(buffer.length * 0.8));
    const frequency = estimateFrequency(middle, sampleRate);
    expect(frequency).toBeGreaterThan(440 * 0.98);
    expect(frequency).toBeLessThan(440 * 1.02);
  });
});
