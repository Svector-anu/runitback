import { describe, expect, it } from "vitest";
import { PEAKS_PER_SECOND, accumulatePeaks, peaksForRange } from "#/platform/waveform";

describe("waveform peaks", () => {
  it("keeps the loudest sample per bucket across channels", () => {
    const peaks = new Float32Array(10);
    const sampleRate = 1000;
    const left = new Float32Array(1000).fill(0.1);
    const right = new Float32Array(1000).fill(0);
    left[5] = -0.5;
    right[15] = 0.9;
    accumulatePeaks({ peaks, channels: [left, right], sampleRate, startSeconds: 0 });
    expect(peaks[0]).toBeCloseTo(0.5);
    expect(peaks[1]).toBeCloseTo(0.9);
    expect(peaks[2]).toBeCloseTo(0.1);
  });
  it("places chunks by their timestamp and ignores samples beyond the array", () => {
    const peaks = new Float32Array(PEAKS_PER_SECOND);
    accumulatePeaks({ peaks, channels: [new Float32Array(100).fill(0.7)], sampleRate: 100, startSeconds: 0.5 });
    expect(peaks[49]).toBe(0);
    expect(peaks[50]).toBeCloseTo(0.7);
    accumulatePeaks({ peaks, channels: [new Float32Array(100).fill(1)], sampleRate: 100, startSeconds: 5 });
    expect(Math.max(...peaks)).toBeCloseTo(0.7);
  });
  it("resamples a source range to display columns taking the max of each", () => {
    const peaks = new Float32Array(400);
    peaks[150] = 0.8;
    const cols = peaksForRange({ peaks, startSeconds: 1, endSeconds: 3, count: 4 });
    expect(Array.from(cols).map((v) => Math.round(v * 10) / 10)).toEqual([0, 0.8, 0, 0]);
    expect(peaksForRange({ peaks, startSeconds: 1, endSeconds: 1, count: 3 })).toEqual(new Float32Array(3));
  });
});
