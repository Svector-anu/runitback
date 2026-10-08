import { describe, expect, it } from "vitest";
import {
  analyzeShots, buildShotRanges, detectSceneCuts, dominantColors, frameSignature, locateCut, motionLevel, motionScore, signatureDistance,
  type TimedSignature,
} from "#/engine/analysis";

const W = 64;
const H = 36;

type Painter = (x: number, y: number) => [number, number, number];

function frame(paint: Painter, noise = 0, seed = 1): Uint8ClampedArray {
  const out = new Uint8ClampedArray(W * H * 4);
  let s = seed;
  const jitter = (): number => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return ((s / 0xffffffff) * 2 - 1) * noise;
  };
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const [r, g, b] = paint(x, y);
      const p = (y * W + x) * 4;
      out[p] = r + jitter();
      out[p + 1] = g + jitter();
      out[p + 2] = b + jitter();
      out[p + 3] = 255;
    }
  }
  return out;
}

const solid = (r: number, g: number, b: number): Painter => () => [r, g, b];

/** A bright square that sits at `x0` on a dark gradient background. */
const squareAt = (x0: number, hue: [number, number, number] = [220, 200, 40]): Painter => (x, y) =>
  x >= x0 && x < x0 + 12 && y >= 12 && y < 24 ? hue : [20 + y, 30 + y, 60 + y];

function sequence(input: { fps: number; seconds: number; paint: (t: number) => Painter; noise?: number }): TimedSignature[] {
  const count = Math.round(input.fps * input.seconds);
  return Array.from({ length: count }, (_, i) => {
    const time = i / input.fps;
    return { time, signature: frameSignature(frame(input.paint(time), input.noise ?? 0, i + 1), W, H) };
  });
}

describe("frameSignature", () => {
  it("has a 16x9 luma grid and normalised histograms", () => {
    const sig = frameSignature(frame(solid(255, 0, 0)), W, H);
    expect(sig.luma).toHaveLength(144);
    expect(sig.luma[0]).toBeCloseTo(0.2126, 3);
    expect(sig.histogram[7]).toBe(1);
    expect(sig.histogram[8]).toBe(1);
    expect(sig.histogram[16]).toBe(1);
    expect(Array.from(sig.histogram.subarray(0, 8)).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 6);
  });

  it("distance is zero for identical frames and large for opposite frames", () => {
    const a = frameSignature(frame(solid(0, 0, 0)), W, H);
    const b = frameSignature(frame(solid(255, 255, 255)), W, H);
    expect(signatureDistance(a, a)).toBe(0);
    expect(signatureDistance(a, b)).toBeGreaterThan(0.95);
  });

  it("separates hue changes at equal luminance through the histogram", () => {
    const red = frameSignature(frame(solid(255, 0, 0)), W, H);
    const green = frameSignature(frame(solid(0, 90, 0)), W, H);
    expect(Math.abs(motionScore(red, green))).toBeLessThan(0.05);
    expect(signatureDistance(red, green)).toBeGreaterThan(0.3);
  });
});

describe("dominantColors", () => {
  it("returns the three biggest colour regions most common first", () => {
    const paint: Painter = (x) => (x < 32 ? [250, 10, 10] : x < 52 ? [10, 240, 10] : [10, 10, 250]);
    expect(dominantColors(frame(paint), W, H)).toEqual(["#fa0a0a", "#0af00a", "#0a0afa"]);
  });

  it("folds near-identical shades together", () => {
    const paint: Painter = (x) => (x < 40 ? [250, 10, 10] : [255, 12, 12]);
    expect(dominantColors(frame(paint), W, H)).toHaveLength(1);
  });
});

describe("detectSceneCuts", () => {
  it("finds hard cuts between differing shots to within one sample", () => {
    const palette = [solid(220, 40, 40), solid(40, 200, 60), solid(50, 60, 230)];
    const samples = sequence({ fps: 4, seconds: 5, paint: (t) => (t < 2 ? palette[0] : t < 3 ? palette[1] : palette[2]) as Painter, noise: 4 });
    const cuts = detectSceneCuts(samples);
    expect(cuts.map((c) => c.time)).toEqual([2, 3]);
    expect(cuts.every((c) => c.score > 0.5)).toBe(true);
  });

  it("locates the exact cut frame from dense samples", () => {
    const dense = sequence({ fps: 30, seconds: 0.5, paint: (t) => (t < 0.2 ? solid(10, 10, 10) : solid(240, 240, 240)) });
    expect(locateCut(dense)?.time).toBeCloseTo(6 / 30, 6);
  });

  it("reports no cuts for static frames, even with sensor noise", () => {
    expect(detectSceneCuts(sequence({ fps: 4, seconds: 30, paint: () => squareAt(20), noise: 6 }))).toEqual([]);
  });

  it("does not cut on steady motion or a slow pan", () => {
    const moving = sequence({ fps: 4, seconds: 20, paint: (t) => squareAt(Math.round(t * 2.5)) });
    expect(detectSceneCuts(moving)).toEqual([]);
  });

  it("does not report a slow cross-fade (conservative on fades)", () => {
    const fade = sequence({
      fps: 4,
      seconds: 8,
      paint: (t) => {
        const k = Math.min(1, Math.max(0, (t - 2) / 4));
        return solid(30 + k * 190, 40 + k * 160, 200 - k * 150);
      },
    });
    expect(detectSceneCuts(fade)).toEqual([]);
  });

  it("enforces the minimum shot length by keeping the stronger of two close cuts", () => {
    const samples = sequence({ fps: 10, seconds: 3, paint: (t) => (t < 1 ? solid(0, 0, 0) : t < 1.2 ? solid(120, 120, 120) : solid(255, 255, 255)) });
    const cuts = detectSceneCuts(samples, { minShotSeconds: 0.5 });
    expect(cuts).toHaveLength(1);
    expect(cuts[0]?.time).toBeCloseTo(1, 6);
  });

  it("still catches a cut inside busy, high-motion footage", () => {
    const samples = sequence({
      fps: 4,
      seconds: 10,
      paint: (t) => (t < 5 ? squareAt(Math.round((t * 13) % 50)) : solid(240, 240, 250)),
    });
    expect(detectSceneCuts(samples).map((c) => c.time)).toEqual([5]);
  });
});

describe("shots, motion and colours", () => {
  it("builds shot ranges that tile the duration", () => {
    expect(buildShotRanges([{ time: 2 }, { time: 3 }], 5)).toEqual([{ start: 0, end: 2 }, { start: 2, end: 3 }, { start: 3, end: 5 }]);
    expect(buildShotRanges([], 4)).toEqual([{ start: 0, end: 4 }]);
  });

  it("labels a static shot low motion and a fast shot high, with each shot's palette", () => {
    const samples = sequence({
      fps: 4,
      seconds: 6,
      paint: (t) => (t < 3 ? solid(250, 10, 10) : squareAt(Math.abs(((Math.round(t * 4) * 8) % 100) - 50))),
    });
    const cuts = detectSceneCuts(samples);
    const shots = analyzeShots({ samples, cuts, durationSeconds: 6 });
    expect(shots).toHaveLength(2);
    expect(shots[0]?.motion).toBe("low");
    expect(shots[0]?.dominantColors[0]).toBe("#fa0a0a");
    expect(shots[1]?.motion).toBe("high");
    expect(shots[1]?.dominantColors.length).toBeGreaterThanOrEqual(2);
  });

  it("maps scores to levels at the documented boundaries", () => {
    expect(motionLevel(0)).toBe("low");
    expect(motionLevel(0.02)).toBe("med");
    expect(motionLevel(0.2)).toBe("high");
  });
});
