import { describe, expect, it } from "vitest";
import { cameraPath, cutTemplate, estimateShift, findTemplate, stabilize, textureScore, thinSeries, trackPoint, type LumaFrame, type MotionSample } from "#/engine/tracking";
import { makeRng } from "./invariants-harness";

const W = 160, H = 90;

interface Blob { cx: number; cy: number; s: number; a: number }

/** A smooth random texture: the same continuous picture can be sampled at any sub-pixel offset, so ground truth is exact. */
function makeScene(seed: number, size = { width: 400, height: 300 }): Blob[] {
  const rng = makeRng(seed);
  return Array.from({ length: 420 }, () => ({ cx: rng.next() * size.width, cy: rng.next() * size.height, s: 1.5 + rng.next() * 3, a: (rng.next() - 0.5) * 320 }));
}

/** The scene seen through a W x H window whose content has moved by (ox, oy): pixel (x, y) shows scene point (x - ox + pad, y - oy + pad). */
function render(scene: Blob[], ox: number, oy: number, options: { noise?: number; seed?: number; overlay?: boolean } = {}): LumaFrame {
  const pad = 120;
  const field = new Float32Array(W * H).fill(128);
  for (const b of scene) {
    const reach = Math.ceil(b.s * 5);
    const cx = b.cx - pad + ox, cy = b.cy - pad + oy;
    for (let y = Math.max(0, Math.floor(cy - reach)); y <= Math.min(H - 1, Math.ceil(cy + reach)); y++) {
      for (let x = Math.max(0, Math.floor(cx - reach)); x <= Math.min(W - 1, Math.ceil(cx + reach)); x++) {
        const dx = x - cx, dy = y - cy;
        field[y * W + x] = (field[y * W + x] as number) + b.a * Math.exp(-(dx * dx + dy * dy) / (2 * b.s * b.s));
      }
    }
  }
  const rng = makeRng(options.seed ?? 1);
  const data = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let v = field[y * W + x] as number;
      if (options.noise) v += (rng.next() - 0.5) * 2 * options.noise;
      if (options.overlay && x > 112 && x < 150 && y > 18 && y < 40) v = 40 + ((x * 7 + y * 13) % 90);
      data[y * W + x] = Math.max(0, Math.min(255, Math.round(v)));
    }
  }
  return { width: W, height: H, data };
}

const SCENE = makeScene(5);

/** The most followable point near the middle of a frame: what a user picks by clicking on a visible corner or speck. */
function bestPointIn(frame: LumaFrame, near = { x: 80, y: 45 }, reach = 25): { x: number; y: number } {
  let best = { x: near.x, y: near.y, score: -1 };
  for (let y = near.y - reach; y <= near.y + reach; y++) for (let x = near.x - reach; x <= near.x + reach; x++) {
    const score = textureScore(frame, x, y, 10);
    if (score > best.score) best = { x, y, score };
  }
  return best;
}
const times = (n: number, fps = 30): number[] => Array.from({ length: n }, (_, i) => i / fps);

describe("template matching", () => {
  it("finds a patch at its sub-pixel position", () => {
    const base = render(SCENE, 0, 0);
    const spot = bestPointIn(base, { x: 60, y: 40 });
    const template = cutTemplate(base, spot.x, spot.y, 10);
    expect(template).not.toBeNull();
    for (const [ox, oy] of [[3.4, -2.7], [-5.5, 6.1], [0.25, 0.75]] as const) {
      const moved = render(SCENE, ox, oy);
      const match = findTemplate(moved, template as NonNullable<typeof template>, spot, 10);
            expect(Math.abs((match?.x ?? 0) - (spot.x + ox))).toBeLessThan(0.1);
      expect(Math.abs((match?.y ?? 0) - (spot.y + oy))).toBeLessThan(0.1);
      expect(match?.score).toBeGreaterThan(0.95);
    }
  });

  it("refuses a flat patch and a straight edge (which can slide along itself unseen)", () => {
    const edge = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) edge[y * W + x] = x < 80 ? 40 : 200;
    expect(cutTemplate({ width: W, height: H, data: edge }, 80, 45, 10)).toBeNull();
    expect(textureScore({ width: W, height: H, data: edge }, 80, 45, 10)).toBeLessThan(1);
    expect(cutTemplate({ width: W, height: H, data: new Uint8Array(W * H).fill(90) }, 50, 40, 10)).toBeNull();
    expect(cutTemplate(render(SCENE, 0, 0), 3, 3, 10)).toBeNull();
  });
});

describe("trackPoint on a synthetic moving pattern", () => {
  const start = bestPointIn(render(SCENE, 0, 0), { x: 70, y: 45 });
  const path = (i: number): { x: number; y: number } => ({ x: 14 * Math.sin(i / 17) + 0.05 * i, y: 8 * Math.sin(i / 11 + 1) - 0.02 * i });

  it("stays within 0.2 px of ground truth on clean frames over 240 frames", () => {
    const n = 240;
    const frames = Array.from({ length: n }, (_, i) => render(SCENE, path(i).x - path(0).x, path(i).y - path(0).y));
    const samples = trackPoint({ frames, times: times(n), start });
    let worst = 0;
    samples.forEach((s, i) => { worst = Math.max(worst, Math.hypot(s.x - (start.x + path(i).x - path(0).x), s.y - (start.y + path(i).y - path(0).y))); });
    expect(samples.some((s) => s.lost)).toBe(false);
    expect(worst).toBeLessThan(0.2);
  }, 120_000);

  it("stays within 0.5 px with sensor noise and a drifting exposure", () => {
    const n = 120;
    const frames = Array.from({ length: n }, (_, i) => {
      const f = render(SCENE, path(i).x, path(i).y, { noise: 6, seed: i + 3 });
      for (let k = 0; k < f.data.length; k++) f.data[k] = Math.max(0, Math.min(255, Math.round((f.data[k] as number) * (1 + 0.15 * Math.sin(i / 20)) + 6 * Math.sin(i / 20))));
      return f;
    });
    const samples = trackPoint({ frames, times: times(n), start: { x: start.x + path(0).x, y: start.y + path(0).y } });
    let worst = 0;
    samples.forEach((s, i) => { worst = Math.max(worst, Math.hypot(s.x - (start.x + path(i).x), s.y - (start.y + path(i).y))); });
    expect(worst).toBeLessThan(0.5);
  }, 120_000);

  it("does not drift: constant slow motion over 300 frames ends within 0.3 px", () => {
    const n = 300;
    const velocity = { x: 0.06, y: -0.03 };
    const frames = Array.from({ length: n }, (_, i) => render(SCENE, velocity.x * i, velocity.y * i));
    const samples = trackPoint({ frames, times: times(n), start });
    const last = samples[n - 1] as (typeof samples)[number];
    expect(Math.hypot(last.x - (start.x + velocity.x * (n - 1)), last.y - (start.y + velocity.y * (n - 1)))).toBeLessThan(0.3);
  }, 60_000);

  it("flags frames where the target is hidden, holds position, and picks the target up again", () => {
    const n = 60;
    const frames = Array.from({ length: n }, (_, i) => {
      if (i >= 20 && i < 26) {
        const rng = makeRng(i + 100);
        return { width: W, height: H, data: Uint8Array.from({ length: W * H }, () => 100 + Math.floor(rng.next() * 60)) };
      }
      return render(SCENE, 0.3 * i, 0.12 * i);
    });
    const samples = trackPoint({ frames, times: times(n), start });
    expect(samples.slice(20, 26).every((s) => s.lost)).toBe(true);
    expect(samples.slice(0, 20).every((s) => !s.lost)).toBe(true);
    expect(samples.slice(27).every((s) => !s.lost)).toBe(true);
    expect(samples[22]).toMatchObject({ x: samples[19]?.x, y: samples[19]?.y });
    const end = samples[n - 1] as (typeof samples)[number];
    expect(Math.hypot(end.x - (start.x + 0.3 * (n - 1)), end.y - (start.y + 0.12 * (n - 1)))).toBeLessThan(0.6);
  }, 60_000);

  it("marks the target lost when it leaves the frame instead of jumping to look-alikes", () => {
    const n = 90;
    const frames = Array.from({ length: n }, (_, i) => render(SCENE, 1.2 * i, 0));
    const left = bestPointIn(frames[0] as LumaFrame, { x: 100, y: 45 }, 8);
    const samples = trackPoint({ frames, times: times(n), start: left });
    for (let i = 1; i < n; i++) {
      const a = samples[i - 1] as (typeof samples)[number], b = samples[i] as (typeof samples)[number];
      expect(Math.hypot(b.x - a.x, b.y - a.y), `frame ${i}`).toBeLessThan(3);
    }
    expect(samples[n - 1]?.lost).toBe(true);
    expect(samples.slice(0, 20).every((s) => !s.lost)).toBe(true);
  }, 60_000);

  it("rejects a flat start point and mismatched inputs", () => {
    const flat: LumaFrame = { width: W, height: H, data: new Uint8Array(W * H).fill(100) };
    expect(() => trackPoint({ frames: [flat], times: [0], start })).toThrow(/texture|detail/);
    expect(() => trackPoint({ frames: [], times: [], start })).toThrow();
    expect(() => trackPoint({ frames: [flat], times: [0, 1], start })).toThrow();
  });
});

describe("camera motion and stabilisation", () => {
  /** Slow pan plus fast hand shake. */
  const pan = (i: number): { x: number; y: number } => ({ x: 0.35 * i, y: 0.1 * i });
  const shakeOf = (seed: number, n: number): Array<{ x: number; y: number }> => {
    const rng = makeRng(seed);
    return Array.from({ length: n }, () => ({ x: (rng.next() - 0.5) * 6, y: (rng.next() - 0.5) * 6 }));
  };

  it("estimateShift recovers a sub-pixel translation, ignoring a subject that moves differently", () => {
    const a = render(SCENE, 0, 0, { overlay: true });
    const b = render(SCENE, 3.3, -2.2, { overlay: true });
    const shift = estimateShift(a, b);
    expect(Math.abs(shift.x - 3.3)).toBeLessThan(0.3);
    expect(Math.abs(shift.y + 2.2)).toBeLessThan(0.3);
    expect(shift.support).toBeGreaterThanOrEqual(4);
  });

  it("cameraPath matches the true motion within 1 px after 90 frames of shake", () => {
    const n = 90;
    const shake = shakeOf(4, n);
    const frames = Array.from({ length: n }, (_, i) => render(SCENE, pan(i).x + shake[i]!.x, pan(i).y + shake[i]!.y, { noise: 3, seed: i }));
    const path = cameraPath({ frames, times: times(n) });
    let worst = 0;
    path.forEach((p, i) => { worst = Math.max(worst, Math.hypot(p.x - (pan(i).x + shake[i]!.x - shake[0]!.x - pan(0).x), p.y - (pan(i).y + shake[i]!.y - shake[0]!.y - pan(0).y))); });
    expect(worst).toBeLessThan(1);
  }, 60_000);

  it("stabilize removes most of the shake and keeps the slow pan", () => {
    const n = 200;
    const shake = shakeOf(9, n);
    const raw: MotionSample[] = Array.from({ length: n }, (_, i) => ({ t: i / 30, x: pan(i).x + shake[i]!.x, y: pan(i).y + shake[i]!.y, support: 5 }));
    const result = stabilize({ path: raw, sigmaSamples: 15 });
    const corrected = raw.map((p, i) => ({ x: p.x + result.corrections[i]!.x, y: p.y + result.corrections[i]!.y }));
    const highPass = (series: number[]): number => {
      const diffs = series.slice(1).map((v, i) => v - (series[i] as number) - 0);
      const mean = diffs.reduce((s, v) => s + v, 0) / diffs.length;
      return Math.sqrt(diffs.reduce((s, v) => s + (v - mean) ** 2, 0) / diffs.length);
    };
    const before = highPass(raw.map((p) => p.x)), after = highPass(corrected.map((p) => p.x));
    expect(after).toBeLessThan(before * 0.25);
    const middle = 100;
    expect(Math.abs(corrected[middle]!.x - pan(middle).x)).toBeLessThan(1);
    expect(result.maxX).toBeLessThan(7);
    expect(result.measuredShare).toBe(1);
  });

  it("a perfectly steady camera needs no correction", () => {
    const raw: MotionSample[] = Array.from({ length: 50 }, (_, i) => ({ t: i, x: 0, y: 0, support: 4 }));
    const result = stabilize({ path: raw, sigmaSamples: 5 });
    expect(result.maxX).toBe(0);
    expect(result.maxY).toBe(0);
  });
});

describe("thinSeries", () => {
  it("keeps the ends and bounds the interpolation error by the tolerance", () => {
    const rng = makeRng(2);
    const series = Array.from({ length: 300 }, (_, i) => ({ t: i, v: 20 * Math.sin(i / 25) + rng.next() }));
    const thin = thinSeries(series, 0.5);
    expect(thin.length).toBeLessThan(series.length / 3);
    expect(thin[0]).toEqual(series[0]);
    expect(thin[thin.length - 1]).toEqual(series[299]);
    for (const p of series) {
      const hi = thin.findIndex((q) => q.t >= p.t);
      const a = thin[Math.max(0, hi - 1)] as (typeof thin)[number], b = thin[hi] as (typeof thin)[number];
      const along = b.t === a.t ? 0 : (p.t - a.t) / (b.t - a.t);
      expect(Math.abs(p.v - (a.v + (b.v - a.v) * along))).toBeLessThanOrEqual(0.5 + 1e-9);
    }
    expect(thinSeries([{ t: 0, v: 1 }], 1)).toHaveLength(1);
  });
});
