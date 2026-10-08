import { describe, expect, it } from "vitest";
import { stretch } from "#/engine/audio";

function sineWave(frequency: number, sampleRate: number, seconds: number): Float32Array {
  const length = Math.round(sampleRate * seconds);
  const out = new Float32Array(length);
  for (let i = 0; i < length; i++) out[i] = Math.sin((2 * Math.PI * frequency * i) / sampleRate);
  return out;
}

/** Autocorrelation pitch estimate — used only to verify stretch() preserves frequency content, not shipped code. */
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

describe("stretch", () => {
  const sampleRate = 44100;

  it("slowing down (rate=0.5) lengthens the signal while keeping its pitch within 2%", () => {
    const input = sineWave(440, sampleRate, 0.5);
    const [output] = stretch({ channels: [input], rate: 0.5, sampleRate });
    expect(output!.length).toBe(Math.round(input.length / 0.5));
    const middle = output!.subarray(Math.floor(output!.length * 0.2), Math.floor(output!.length * 0.8));
    const frequency = estimateFrequency(middle, sampleRate);
    expect(frequency).toBeGreaterThan(440 * 0.98);
    expect(frequency).toBeLessThan(440 * 1.02);
  });

  it("speeding up (rate=2) shortens the signal while keeping its pitch within 2%", () => {
    const input = sineWave(440, sampleRate, 0.5);
    const [output] = stretch({ channels: [input], rate: 2, sampleRate });
    expect(output!.length).toBe(Math.round(input.length / 2));
    const middle = output!.subarray(Math.floor(output!.length * 0.2), Math.floor(output!.length * 0.8));
    const frequency = estimateFrequency(middle, sampleRate);
    expect(frequency).toBeGreaterThan(440 * 0.98);
    expect(frequency).toBeLessThan(440 * 1.02);
  });

  it("produces non-silent output at the expected sample count", () => {
    const input = sineWave(220, sampleRate, 0.3);
    const [output] = stretch({ channels: [input], rate: 1.5, sampleRate });
    expect(output!.length).toBe(Math.round(input.length / 1.5));
    const peak = Math.max(...Array.from(output!, Math.abs));
    expect(peak).toBeGreaterThan(0.1);
  });

  it("applies the same stretch length and relative gain across channels", () => {
    const left = sineWave(440, sampleRate, 0.3);
    const right = sineWave(440, sampleRate, 0.3).map((v) => v * 0.5);
    const [outLeft, outRight] = stretch({ channels: [left, right], rate: 1.7, sampleRate });
    expect(outLeft!.length).toBe(outRight!.length);
    const peak = (buf: Float32Array) => Math.max(...Array.from(buf, Math.abs));
    expect(peak(outRight!)).toBeLessThan(peak(outLeft!));
  });

  it("rate=1 passes the signal through at the same length", () => {
    const input = sineWave(300, sampleRate, 0.1);
    const [output] = stretch({ channels: [input], rate: 1, sampleRate });
    expect(output!.length).toBe(input.length);
  });

  it("is a no-op shape for empty input", () => {
    expect(stretch({ channels: [], rate: 2, sampleRate })).toEqual([]);
    expect(stretch({ channels: [new Float32Array(0)], rate: 2, sampleRate })).toEqual([new Float32Array(0)]);
  });
});
