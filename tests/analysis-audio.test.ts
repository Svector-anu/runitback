import { describe, expect, it } from "vitest";
import {
  RmsAccumulator, computeRmsWindows, detectOnsets, detectSilence, detectSpeechLikeRanges, estimateTempo, levelCurve, loudnessStats,
} from "#/engine/analysis";

const SAMPLE_RATE = 16_000;

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0xffffffff;
  };
}

function tone(input: { seconds: number; amplitude: number; hz?: number }): Float32Array {
  const out = new Float32Array(Math.round(input.seconds * SAMPLE_RATE));
  for (let i = 0; i < out.length; i++) out[i] = Math.sin((2 * Math.PI * (input.hz ?? 440) * i) / SAMPLE_RATE) * input.amplitude;
  return out;
}

function concat(...parts: Float32Array[]): Float32Array {
  const out = new Float32Array(parts.reduce((a, p) => a + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

const silence = (seconds: number): Float32Array => new Float32Array(Math.round(seconds * SAMPLE_RATE));

function noise(seconds: number, amplitude: number, seed = 1): Float32Array {
  const random = rng(seed);
  const out = new Float32Array(Math.round(seconds * SAMPLE_RATE));
  for (let i = 0; i < out.length; i++) out[i] = (random() * 2 - 1) * amplitude;
  return out;
}

/** Short decaying noise bursts every 60/bpm seconds, starting at `offset`. */
function clickTrack(input: { bpm: number; seconds: number; offset?: number }): { samples: Float32Array; times: number[] } {
  const samples = new Float32Array(Math.round(input.seconds * SAMPLE_RATE));
  const random = rng(7);
  const times: number[] = [];
  const period = 60 / input.bpm;
  for (let t = input.offset ?? 0.1; t < input.seconds - 0.1; t += period) {
    times.push(t);
    const start = Math.round(t * SAMPLE_RATE);
    const length = Math.round(0.02 * SAMPLE_RATE);
    for (let i = 0; i < length; i++) samples[start + i] = (random() * 2 - 1) * 0.8 * (1 - i / length);
  }
  return { samples, times };
}

describe("detectSilence", () => {
  it("finds a gap of exact length within one window on each side", () => {
    const samples = concat(tone({ seconds: 2, amplitude: 0.3 }), silence(1), tone({ seconds: 2, amplitude: 0.3 }));
    const found = detectSilence({ samples, sampleRate: SAMPLE_RATE, thresholdDb: -50, minDuration: 0.3 });
    expect(found).toHaveLength(1);
    expect(found[0]?.start).toBeCloseTo(2, 1);
    expect(Math.abs((found[0]?.start ?? 0) - 2)).toBeLessThanOrEqual(0.02);
    expect(Math.abs((found[0]?.end ?? 0) - 3)).toBeLessThanOrEqual(0.02);
    expect(found[0]?.meanDb).toBeLessThan(-90);
  });

  it("ignores gaps shorter than minDuration", () => {
    const samples = concat(tone({ seconds: 1, amplitude: 0.3 }), silence(0.2), tone({ seconds: 1, amplitude: 0.3 }));
    expect(detectSilence({ samples, sampleRate: SAMPLE_RATE, thresholdDb: -50, minDuration: 0.3 })).toEqual([]);
  });

  it("reports leading and trailing silence", () => {
    const samples = concat(silence(0.5), tone({ seconds: 1, amplitude: 0.3 }), silence(0.7));
    const found = detectSilence({ samples, sampleRate: SAMPLE_RATE });
    expect(found).toHaveLength(2);
    expect(found[0]?.start).toBe(0);
    expect(found[1]?.end).toBeCloseTo(2.2, 1);
  });

  it("finds no silence in steady noise or a steady tone", () => {
    expect(detectSilence({ samples: noise(5, 0.05), sampleRate: SAMPLE_RATE })).toEqual([]);
    expect(detectSilence({ samples: tone({ seconds: 5, amplitude: 0.01 }), sampleRate: SAMPLE_RATE })).toEqual([]);
  });

  it("treats quiet room tone as silent only when under the threshold", () => {
    const quiet = noise(2, 0.001);
    expect(detectSilence({ samples: quiet, sampleRate: SAMPLE_RATE, thresholdDb: -45 })).toHaveLength(1);
    expect(detectSilence({ samples: quiet, sampleRate: SAMPLE_RATE, thresholdDb: -80 })).toEqual([]);
  });
});

describe("loudnessStats", () => {
  it("measures a sine's peak and RMS in dBFS", () => {
    const stats = loudnessStats(computeRmsWindows({ samples: tone({ seconds: 3, amplitude: 0.5 }), sampleRate: SAMPLE_RATE }));
    expect(stats.peakDb).toBeCloseTo(20 * Math.log10(0.5), 1);
    expect(stats.rmsDb).toBeCloseTo(20 * Math.log10(0.5 / Math.SQRT2), 1);
    expect(stats.integratedApproxDb).toBeCloseTo(stats.rmsDb, 1);
  });

  it("gates silence out of the integrated figure but not out of the plain RMS", () => {
    const samples = concat(tone({ seconds: 2, amplitude: 0.5 }), silence(6));
    const stats = loudnessStats(computeRmsWindows({ samples, sampleRate: SAMPLE_RATE }));
    expect(Math.abs(stats.integratedApproxDb - 20 * Math.log10(0.5 / Math.SQRT2))).toBeLessThan(0.5);
    expect(stats.rmsDb).toBeLessThan(stats.integratedApproxDb - 5);
  });

  it("reports the floor for digital silence", () => {
    const stats = loudnessStats(computeRmsWindows({ samples: silence(2), sampleRate: SAMPLE_RATE }));
    expect(stats.peakDb).toBe(-100);
    expect(stats.integratedApproxDb).toBe(-100);
  });

  it("streaming chunks give the same windows as one buffer, with stereo mixed to mono", () => {
    const samples = tone({ seconds: 1, amplitude: 0.4 });
    const whole = computeRmsWindows({ samples, sampleRate: SAMPLE_RATE });
    const acc = new RmsAccumulator();
    const chunk = 1234;
    for (let i = 0; i < samples.length; i += chunk) {
      const part = samples.subarray(i, i + chunk);
      acc.push({ channels: [part, part], sampleRate: SAMPLE_RATE, startSeconds: i / SAMPLE_RATE });
    }
    const streamed = acc.finish();
    expect(streamed.meanSquare.length).toBe(whole.meanSquare.length);
    for (let i = 0; i < whole.meanSquare.length; i++) expect(streamed.meanSquare[i]).toBeCloseTo(whole.meanSquare[i] as number, 5);
  });

  it("level curve averages power per window", () => {
    const samples = concat(tone({ seconds: 0.5, amplitude: 0.5 }), silence(0.5));
    const curve = levelCurve(computeRmsWindows({ samples, sampleRate: SAMPLE_RATE }), 0.25);
    expect(curve.windowSeconds).toBeCloseTo(0.26, 2);
    expect(curve.db[0]).toBeCloseTo(20 * Math.log10(0.5 / Math.SQRT2), 0);
    expect(curve.db[curve.db.length - 1]).toBe(-100);
  });
});

describe("speech-like ranges (heuristic)", () => {
  it("accepts syllable-modulated bursts and rejects a steady tone and steady noise", () => {
    const syllable = (): Float32Array => {
      const out = tone({ seconds: 0.18, amplitude: 0.3, hz: 200 });
      for (let i = 0; i < out.length; i++) out[i] = (out[i] as number) * Math.sin((Math.PI * i) / out.length);
      return out;
    };
    const word = concat(syllable(), silence(0.06), syllable(), silence(0.06), syllable(), silence(0.06), syllable());
    const speech = concat(silence(1), word, silence(1));
    const found = detectSpeechLikeRanges(computeRmsWindows({ samples: speech, sampleRate: SAMPLE_RATE }));
    expect(found).toHaveLength(1);
    expect(found[0]?.start).toBeGreaterThan(0.9);
    expect(found[0]?.end).toBeLessThan(2.1);

    expect(detectSpeechLikeRanges(computeRmsWindows({ samples: concat(silence(1), tone({ seconds: 2, amplitude: 0.3 }), silence(1)), sampleRate: SAMPLE_RATE }))).toEqual([]);
    expect(detectSpeechLikeRanges(computeRmsWindows({ samples: noise(4, 0.1), sampleRate: SAMPLE_RATE }))).toEqual([]);
  });
});

describe("detectOnsets", () => {
  it("places onsets within one window of the true impulse times", () => {
    const { samples, times } = clickTrack({ bpm: 120, seconds: 10 });
    const onsets = detectOnsets(computeRmsWindows({ samples, sampleRate: SAMPLE_RATE }));
    expect(onsets).toHaveLength(times.length);
    onsets.forEach((o, i) => expect(Math.abs(o.time - (times[i] as number))).toBeLessThanOrEqual(0.021));
    expect(onsets.every((o) => o.strength > 0.5)).toBe(true);
  });

  it("finds no onsets in steady noise or a steady tone", () => {
    expect(detectOnsets(computeRmsWindows({ samples: noise(8, 0.2), sampleRate: SAMPLE_RATE }))).toEqual([]);
    expect(detectOnsets(computeRmsWindows({ samples: tone({ seconds: 8, amplitude: 0.4 }), sampleRate: SAMPLE_RATE }))).toEqual([]);
  });
});

describe("estimateTempo", () => {
  it.each([62, 75, 83, 90, 100, 110, 128, 140, 150, 165, 174, 185, 198])("recovers %d BPM within 1.5 BPM", (bpm) => {
    const { samples } = clickTrack({ bpm, seconds: 20 });
    const tempo = estimateTempo(detectOnsets(computeRmsWindows({ samples, sampleRate: SAMPLE_RATE })));
    expect(tempo).not.toBeNull();
    expect(Math.abs((tempo?.bpm ?? 0) - bpm)).toBeLessThan(1.5);
    expect(tempo?.confidence).toBeGreaterThan(0.3);
  });

  it("returns null with too few onsets and for irregular noise bursts", () => {
    expect(estimateTempo([{ time: 1, strength: 1 }, { time: 2, strength: 1 }])).toBeNull();
    const random = rng(99);
    const irregular = Array.from({ length: 30 }, (_, i) => ({ time: i * 0.6 + random() * 0.5, strength: 1 }));
    const tempo = estimateTempo(irregular);
    expect(tempo === null || tempo.confidence < 0.6).toBe(true);
  });
});
