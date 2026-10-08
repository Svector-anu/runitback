import { describe, expect, it } from "vitest";
import { buildStyleProfile, planCutsToProfile, type CutPlan, type SourceRange } from "#/engine/reference";
import { ksDistance, ksTwoSample, syntheticAnalysis } from "./reference-fixtures";

const spread = (n: number, scale: number): number[] => Array.from({ length: n }, (_, i) => scale * (0.5 + ((i * 37) % 100) / 50));
const profile = buildStyleProfile([syntheticAnalysis({ assetId: "ref", lengths: spread(120, 1) })]);
const beatLengths = Array.from({ length: 40 }, (_, i) => 0.5 * (1 + (i % 4)));
const beatProfile = buildStyleProfile([syntheticAnalysis({ assetId: "beat", lengths: beatLengths, bpm: 120 })]);
const sources: SourceRange[] = [{ assetId: "a", start: 0, end: 300 }, { assetId: "b", start: 0, end: 200 }];
const bounds = { minShot: 0.5, maxShot: 2.5 };

const durations = (plan: CutPlan): number[] => plan.shots.map((s) => s.duration);

describe("planCutsToProfile", () => {
  it("matches the target length distribution (KS distance) and total duration", () => {
    const plan = planCutsToProfile({ sourceRanges: sources, profile, ...bounds, seed: 3, targetDuration: 240 });
    expect(plan.totalSeconds).toBeCloseTo(240, 6);
    expect(plan.shots.length).toBeGreaterThan(120);
    expect(ksDistance(durations(plan).slice(0, -1), profile.shots.quantiles)).toBeLessThan(0.04);
    const meanLength = plan.totalSeconds / plan.shots.length;
    expect(Math.abs(meanLength - profile.shots.meanSeconds) / profile.shots.meanSeconds).toBeLessThan(0.05);
  });

  it("stays close to the target even for short outputs", () => {
    const plan = planCutsToProfile({ sourceRanges: sources, profile, ...bounds, seed: 11, targetDuration: 40 });
    expect(ksDistance(durations(plan).slice(0, -1), profile.shots.quantiles)).toBeLessThan(0.12);
  });

  it("is deterministic per seed and varies across seeds", () => {
    const run = (seed: number) => planCutsToProfile({ sourceRanges: sources, profile, ...bounds, seed, targetDuration: 60 });
    expect(run(5)).toEqual(run(5));
    expect(durations(run(5))).not.toEqual(durations(run(6)));
  });

  it("never exceeds source bounds or reuses footage, and keeps shots in min/max", () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      const plan = planCutsToProfile({ sourceRanges: sources, profile, ...bounds, seed });
      const used = new Map<string, Array<[number, number]>>();
      for (const shot of plan.shots) {
        const range = sources.find((r) => r.assetId === shot.assetId) as SourceRange;
        expect(shot.in).toBeGreaterThanOrEqual(range.start);
        expect(shot.out).toBeLessThanOrEqual(range.end);
        expect(shot.out - shot.in).toBeCloseTo(shot.duration, 9);
        expect(shot.duration).toBeGreaterThanOrEqual(bounds.minShot - 1e-9);
        expect(shot.duration).toBeLessThanOrEqual(bounds.maxShot + 1e-9);
        const list = used.get(shot.assetId) ?? [];
        for (const [a, b] of list) expect(shot.in >= b - 1e-9 || shot.out <= a + 1e-9).toBe(true);
        list.push([shot.in, shot.out]);
        used.set(shot.assetId, list);
      }
      let cursor = 0;
      for (const shot of plan.shots) {
        expect(shot.start).toBeCloseTo(cursor, 9);
        cursor += shot.duration;
      }
    }
  });

  it("caps the target at the usable footage and says so", () => {
    const plan = planCutsToProfile({ sourceRanges: [{ assetId: "a", start: 0, end: 20 }], profile, ...bounds, seed: 1, targetDuration: 100 });
    expect(plan.totalSeconds).toBeLessThanOrEqual(20 + 1e-9);
    expect(plan.totalSeconds).toBeGreaterThan(19);
    expect(plan.notes.join(" ")).toContain("exceeds usable source");
  });

  it("handles sources that are too short and invalid bounds", () => {
    const tiny = planCutsToProfile({ sourceRanges: [{ assetId: "a", start: 0, end: 0.2 }], profile, ...bounds, seed: 1 });
    expect(tiny.shots).toEqual([]);
    expect(tiny.notes.length).toBeGreaterThan(0);
    expect(() => planCutsToProfile({ sourceRanges: sources, profile, minShot: 3, maxShot: 1, seed: 1 })).toThrow(RangeError);
    expect(() => planCutsToProfile({ sourceRanges: sources, profile, minShot: 0, maxShot: 1, seed: 1 })).toThrow(RangeError);
  });

  it("respects ranges with an offset start", () => {
    const plan = planCutsToProfile({ sourceRanges: [{ assetId: "a", start: 50, end: 90 }], profile, ...bounds, seed: 2 });
    expect(plan.shots.every((s) => s.in >= 50 && s.out <= 90)).toBe(true);
  });
});

describe("beat snapping", () => {
  const beats = Array.from({ length: 800 }, (_, i) => i * 0.5);
  const onBeat = (time: number): number => Math.min(...beats.map((b) => Math.abs(b - time)));

  it("puts nearly every cut on a beat when the reference cut to the beat", () => {
    expect(beatProfile.beatLock.score).toBe(1);
    const plan = planCutsToProfile({ sourceRanges: sources, profile: beatProfile, beats, minShot: 0.5, maxShot: 2, seed: 4, targetDuration: 120 });
    expect(plan.beatSnapped).toBe(true);
    const cuts = plan.shots.slice(1).map((s) => s.start);
    const locked = cuts.filter((c) => onBeat(c) <= 0.08).length / cuts.length;
    expect(locked).toBeGreaterThanOrEqual(0.95);
    for (const shot of plan.shots) {
      expect(shot.duration).toBeGreaterThanOrEqual(0.5 - 1e-9);
      expect(shot.duration).toBeLessThanOrEqual(2 + 1e-9);
    }
    expect(plan.totalSeconds).toBeCloseTo(120, 6);
  });

  it("keeps the length distribution reasonable while snapping", () => {
    const plan = planCutsToProfile({ sourceRanges: sources, profile: beatProfile, beats, minShot: 0.5, maxShot: 2, seed: 4, targetDuration: 200 });
    expect(ksTwoSample(durations(plan).slice(0, -1), beatLengths)).toBeLessThan(0.1);
  });

  it("does not snap when the reference ignored the beat, or when no beats are given", () => {
    const loose = buildStyleProfile([syntheticAnalysis({ assetId: "loose", lengths: [1.1, 1.3, 0.7, 2.1, 1.7, 0.9], bpm: 120 })]);
    expect(loose.beatLock.score).toBeLessThan(0.5);
    const unsnapped = planCutsToProfile({ sourceRanges: sources, profile: loose, beats, minShot: 0.5, maxShot: 2.5, seed: 4, targetDuration: 60 });
    expect(unsnapped.beatSnapped).toBe(false);
    expect(unsnapped.notes.join(" ")).toContain("does not cut to the beat");
    const without = planCutsToProfile({ sourceRanges: sources, profile: beatProfile, minShot: 0.5, maxShot: 2, seed: 4, targetDuration: 60 });
    expect(without.beatSnapped).toBe(false);
  });
});
