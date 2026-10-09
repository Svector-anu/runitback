import { describe, expect, it } from "vitest";
import {
  BS1770_LUFS_OFFSET_DB, IntegratedLoudnessAccumulator, bs1770ChannelWeights, SILENCE_FLOOR_DB, computeKWeightedWindows, computeRmsWindows, loudnessStats,
} from "#/engine/analysis";

const SAMPLE_RATE = 16_000;

function tone(input: { seconds: number; amplitude: number; hz: number }): Float32Array {
  const out = new Float32Array(Math.round(input.seconds * SAMPLE_RATE));
  for (let i = 0; i < out.length; i++) out[i] = Math.sin((2 * Math.PI * input.hz * i) / SAMPLE_RATE) * input.amplitude;
  return out;
}

const silence = (seconds: number): Float32Array => new Float32Array(Math.round(seconds * SAMPLE_RATE));

function concat(...parts: Float32Array[]): Float32Array {
  const out = new Float32Array(parts.reduce((a, p) => a + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

/**
 * Independent re-derivation of the K-weighting magnitude response (RBJ cookbook biquad formulas, same BS.1770
 * Annex 1 f0/Q/gain values the implementation uses) so the "expected" LUFS for a calibration tone below is
 * computed from first principles, not by calling back into `audio.ts`.
 */
function biquadGainAt(sampleRate: number, hz: number, design: { kind: "shelf"; gainDb: number } | { kind: "highpass" }, f0: number, q: number): number {
  const w0 = (2 * Math.PI * f0) / sampleRate;
  const cosW0 = Math.cos(w0);
  const alpha = Math.sin(w0) / (2 * q);
  let b0: number, b1: number, b2: number, a0: number, a1: number, a2: number;
  if (design.kind === "shelf") {
    const a = 10 ** (design.gainDb / 40);
    const sqrtA = Math.sqrt(a);
    a0 = a + 1 - (a - 1) * cosW0 + 2 * sqrtA * alpha;
    b0 = a * (a + 1 + (a - 1) * cosW0 + 2 * sqrtA * alpha);
    b1 = -2 * a * (a - 1 + (a + 1) * cosW0);
    b2 = a * (a + 1 + (a - 1) * cosW0 - 2 * sqrtA * alpha);
    a1 = 2 * (a - 1 - (a + 1) * cosW0);
    a2 = a + 1 - (a - 1) * cosW0 - 2 * sqrtA * alpha;
  } else {
    a0 = 1 + alpha;
    b0 = (1 + cosW0) / 2;
    b1 = -(1 + cosW0);
    b2 = (1 + cosW0) / 2;
    a1 = -2 * cosW0;
    a2 = 1 - alpha;
  }
  const w = (2 * Math.PI * hz) / sampleRate;
  const nRe = b0 / a0 + (b1 / a0) * Math.cos(w) + (b2 / a0) * Math.cos(2 * w);
  const nIm = -(b1 / a0) * Math.sin(w) - (b2 / a0) * Math.sin(2 * w);
  const dRe = 1 + (a1 / a0) * Math.cos(w) + (a2 / a0) * Math.cos(2 * w);
  const dIm = -(a1 / a0) * Math.sin(w) - (a2 / a0) * Math.sin(2 * w);
  return Math.sqrt((nRe * nRe + nIm * nIm) / (dRe * dRe + dIm * dIm));
}

function kWeightGainAt(sampleRate: number, hz: number): number {
  const shelfGain = biquadGainAt(sampleRate, hz, { kind: "shelf", gainDb: 3.99984385397 }, 1681.9744509555612, 0.7071752369554193);
  const highPassGain = biquadGainAt(sampleRate, hz, { kind: "highpass" }, 38.13547087613982, 0.5003270373253953);
  return shelfGain * highPassGain;
}

/** Amplitude of a steady `hz` sine whose K-weighted integrated loudness computes to exactly `targetLufs`. */
function amplitudeForLufs(targetLufs: number, hz: number): number {
  const gain = kWeightGainAt(SAMPLE_RATE, hz);
  const power = 10 ** ((targetLufs - BS1770_LUFS_OFFSET_DB) / 10);
  return Math.sqrt((2 * power) / (gain * gain));
}

describe("K-weighted integrated loudness (true LUFS)", () => {
  it("measures a calibrated 1 kHz tone within +-0.1 LU of -23 LUFS", () => {
    const amplitude = amplitudeForLufs(-23, 1000);
    const samples = tone({ seconds: 3, amplitude, hz: 1000 });
    const stats = loudnessStats(computeRmsWindows({ samples, sampleRate: SAMPLE_RATE }), computeKWeightedWindows({ samples, sampleRate: SAMPLE_RATE }));
    expect(stats.integratedLufs).toBeDefined();
    expect(Math.abs((stats.integratedLufs as number) - -23)).toBeLessThan(0.1);
  });

  it("leaves rmsDb/peakDb/integratedApproxDb untouched when K-weighted windows are given", () => {
    const amplitude = amplitudeForLufs(-23, 1000);
    const samples = tone({ seconds: 3, amplitude, hz: 1000 });
    const windows = computeRmsWindows({ samples, sampleRate: SAMPLE_RATE });
    const withoutKWeight = loudnessStats(windows);
    const withKWeight = loudnessStats(windows, computeKWeightedWindows({ samples, sampleRate: SAMPLE_RATE }));
    expect(withKWeight.peakDb).toBe(withoutKWeight.peakDb);
    expect(withKWeight.rmsDb).toBe(withoutKWeight.rmsDb);
    expect(withKWeight.integratedApproxDb).toBe(withoutKWeight.integratedApproxDb);
    expect(withoutKWeight.integratedLufs).toBeUndefined();
  });

  it("gates silence out of the LUFS figure, same as the unweighted approximation", () => {
    const amplitude = amplitudeForLufs(-23, 1000);
    const samples = concat(tone({ seconds: 2, amplitude, hz: 1000 }), silence(6));
    const stats = loudnessStats(computeRmsWindows({ samples, sampleRate: SAMPLE_RATE }), computeKWeightedWindows({ samples, sampleRate: SAMPLE_RATE }));
    // Looser tolerance than the steady-state calibration test above: the tone/silence edge contributes a
    // partial block near the 2s boundary, same slack the pre-existing unweighted-approximation test allows.
    expect(Math.abs((stats.integratedLufs as number) - -23)).toBeLessThan(0.5);
    expect(stats.rmsDb).toBeLessThan((stats.integratedLufs as number) - 5);
  });

  it("reports the floor for digital silence", () => {
    const samples = silence(2);
    const stats = loudnessStats(computeRmsWindows({ samples, sampleRate: SAMPLE_RATE }), computeKWeightedWindows({ samples, sampleRate: SAMPLE_RATE }));
    expect(stats.integratedLufs).toBe(SILENCE_FLOOR_DB);
  });

  it("streaming chunks through IntegratedLoudnessAccumulator match one whole-buffer pass (filter state carries across pushes)", () => {
    const amplitude = amplitudeForLufs(-23, 1000);
    const samples = tone({ seconds: 1.5, amplitude, hz: 1000 });
    const whole = computeKWeightedWindows({ samples, sampleRate: SAMPLE_RATE });
    const acc = new IntegratedLoudnessAccumulator();
    const chunk = 777;
    for (let i = 0; i < samples.length; i += chunk) {
      const part = samples.subarray(i, i + chunk);
      acc.push({ channels: [part], sampleRate: SAMPLE_RATE, startSeconds: i / SAMPLE_RATE });
    }
    const streamed = acc.finish();
    expect(streamed.meanSquare.length).toBe(whole.meanSquare.length);
    for (let i = 0; i < whole.meanSquare.length; i++) expect(streamed.meanSquare[i]).toBeCloseTo(whole.meanSquare[i] as number, 5);
  });

  it("differs from the unweighted approximation by roughly the BS.1770 offset at a mid-band frequency", () => {
    const samples = tone({ seconds: 3, amplitude: 0.3, hz: 1000 });
    const stats = loudnessStats(computeRmsWindows({ samples, sampleRate: SAMPLE_RATE }), computeKWeightedWindows({ samples, sampleRate: SAMPLE_RATE }));
    const powerGainDb = 20 * Math.log10(kWeightGainAt(SAMPLE_RATE, 1000));
    const expectedLufs = stats.integratedApproxDb + powerGainDb + BS1770_LUFS_OFFSET_DB;
    expect(stats.integratedLufs as number).toBeCloseTo(expectedLufs, 1);
  });

  it("sums channel power per BS.1770: identical stereo channels read 3.01 LU above the same signal in mono", () => {
    const samples = tone({ seconds: 3, amplitude: amplitudeForLufs(-23, 1000), hz: 1000 });
    const lufsFor = (channels: Float32Array[]): number => {
      const accumulator = new IntegratedLoudnessAccumulator();
      accumulator.push({ channels, sampleRate: SAMPLE_RATE, startSeconds: 0 });
      const k = accumulator.finish();
      return loudnessStats(computeRmsWindows({ samples, sampleRate: SAMPLE_RATE }), k).integratedLufs as number;
    };
    const mono = lufsFor([samples]);
    const stereo = lufsFor([samples, samples]);
    expect(stereo - mono).toBeCloseTo(10 * Math.log10(2), 1);
  });

  it("a channel that is silent contributes nothing", () => {
    const samples = tone({ seconds: 3, amplitude: amplitudeForLufs(-23, 1000), hz: 1000 });
    const lufsFor = (channels: Float32Array[]): number => {
      const accumulator = new IntegratedLoudnessAccumulator();
      accumulator.push({ channels, sampleRate: SAMPLE_RATE, startSeconds: 0 });
      return loudnessStats(computeRmsWindows({ samples, sampleRate: SAMPLE_RATE }), accumulator.finish()).integratedLufs as number;
    };
    expect(lufsFor([samples, new Float32Array(samples.length)])).toBeCloseTo(lufsFor([samples]), 2);
  });

  it("uses BS.1770 channel weights: 5.1 drops the LFE and weighs surrounds 1.41; unknown layouts count only front L/R", () => {
    expect(bs1770ChannelWeights(1)).toEqual([1]);
    expect(bs1770ChannelWeights(2)).toEqual([1, 1]);
    expect(bs1770ChannelWeights(6)).toEqual([1, 1, 1, 0, 1.41, 1.41]);
    expect(bs1770ChannelWeights(4)).toEqual([1, 1, 0, 0]);
  });

  it("a 5.1 signal with only a surround channel active reads 10*log10(1.41) (about 1.5 LU) above the same signal on a front channel", () => {
    const samples = tone({ seconds: 3, amplitude: amplitudeForLufs(-30, 1000), hz: 1000 });
    const silent = new Float32Array(samples.length);
    const lufsFor = (channels: Float32Array[]): number => {
      const accumulator = new IntegratedLoudnessAccumulator();
      accumulator.push({ channels, sampleRate: SAMPLE_RATE, startSeconds: 0 });
      return loudnessStats(computeRmsWindows({ samples, sampleRate: SAMPLE_RATE }), accumulator.finish()).integratedLufs as number;
    };
    const front = lufsFor([samples, silent, silent, silent, silent, silent]);
    const surround = lufsFor([silent, silent, silent, silent, samples, silent]);
    expect(surround - front).toBeCloseTo(10 * Math.log10(1.41), 1);
  });
});
