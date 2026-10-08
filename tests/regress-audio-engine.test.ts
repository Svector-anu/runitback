import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AudioClip } from "#/engine/audio";
import type { Playback } from "#/engine/editor";
import { TICKS_PER_SECOND } from "#/engine/time";

const scheduled: Array<{ key: string; from: number }> = [];

vi.mock("#/platform/audio-scheduler", () => ({
  createMasterChain: () => ({ input: {}, output: { connect: () => undefined }, volume: { gain: { setValueAtTime: () => undefined } } }),
  createClipGain: () => ({}),
  stopClip: () => undefined,
  scheduleClipWindow: async (args: { clip: AudioClip; from: number }) => { scheduled.push({ key: args.clip.key, from: args.from }); },
}));

const { AudioEngine } = await import("#/platform/audio-engine");

let contextTime = 0;
let contextsCreated = 0;

class FakeAudioContext {
  destination = {};
  constructor() { contextsCreated++; }
  get currentTime(): number { return contextTime; }
  resume(): Promise<void> { return Promise.resolve(); }
  close(): Promise<void> { return Promise.resolve(); }
}

const clip = (key: string): AudioClip => ({ key, mediaId: key, start: 0, duration: 100 } as unknown as AudioClip);

function fakePlayback(): { playback: Playback; setTime: (s: number) => void } {
  let time = 0;
  const playback = {
    getState: () => ({ isPlaying: true, isScrubbing: false, currentTime: time * TICKS_PER_SECOND, volume: 1, muted: false }),
    subscribe: () => () => undefined,
    onSeek: () => () => undefined,
  } as unknown as Playback;
  return { playback, setTime: (s) => { time = s; } };
}

const flush = async (): Promise<void> => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("AudioContext", FakeAudioContext);
  scheduled.length = 0;
  contextTime = 0;
  contextsCreated = 0;
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("P1-5 a tick in flight across a seek", () => {
  it("does not leave a stale cursor that silences a clip after seeking backwards", async () => {
    const { playback, setTime } = fakePlayback();
    const pending = new Map<string, Array<() => void>>();
    let auto = false;
    const sinks = {
      get: (id: string) => auto ? Promise.resolve({}) : new Promise((resolve) => {
        const list = pending.get(id) ?? [];
        list.push(() => resolve({}));
        pending.set(id, list);
      }),
    };
    const engine = new AudioEngine({ playback, getClips: () => [clip("a"), clip("b")], sinks: sinks as never });

    setTime(10);
    engine.restart();
    await flush();
    setTime(2);
    engine.restart();
    await flush();

    const resolveNext = async (id: string, index: number): Promise<void> => {
      pending.get(id)?.[index]?.();
      await flush();
    };
    await resolveNext("a", 1);
    await resolveNext("b", 0);
    await resolveNext("a", 0);
    pending.forEach((list) => list.forEach((resolve) => resolve()));
    await flush();
    auto = true;

    scheduled.length = 0;
    contextTime = 0.3;
    await vi.advanceTimersByTimeAsync(250);
    await flush();
    await flush();

    expect(scheduled.map((s) => s.key)).toContain("b");
    expect(scheduled.find((s) => s.key === "b")?.from).toBeLessThan(5);
    engine.dispose();
  });
});

describe("P1-3 restart after dispose", () => {
  it("does not create an AudioContext or timer", () => {
    const { playback } = fakePlayback();
    const engine = new AudioEngine({ playback, getClips: () => [], sinks: { get: async () => null } as never });
    engine.dispose();
    engine.restart();
    expect(contextsCreated).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});
