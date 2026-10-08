import { describe, expect, it } from "vitest";
import { analyzeTimelinePacing, type TimelineTrackInput } from "#/engine/analysis";
import { buildStyleProfile, compareToProfile, describeStyleProfile, rhythmOf } from "#/engine/reference";
import { syntheticAnalysis } from "./reference-fixtures";

const lengths = [1, 1, 1, 1, 1, 2, 2, 2, 3, 6];

describe("buildStyleProfile statistics", () => {
  const profile = buildStyleProfile([syntheticAnalysis({ assetId: "ref", lengths })]);

  it("computes exact shot-length statistics", () => {
    expect(profile.shots.count).toBe(10);
    expect(profile.shots.meanSeconds).toBeCloseTo(2, 12);
    expect(profile.shots.medianSeconds).toBe(1.5);
    expect(profile.shots.p10Seconds).toBeCloseTo(1, 12);
    expect(profile.shots.p90Seconds).toBeCloseTo(3 + 0.1 * 3, 12);
    expect(profile.shots.quantiles).toHaveLength(21);
    expect(profile.shots.quantiles[0]).toBe(1);
    expect(profile.shots.quantiles[20]).toBe(6);
    expect(profile.totalSeconds).toBe(20);
    expect(profile.shots.cutsPerMinute).toBeCloseTo(9 / (20 / 60), 9);
    expect(profile.shots.hookSeconds).toBe(1);
    expect(profile.sourceIds).toEqual(["ref"]);
  });

  it("builds a histogram that sums to one over the pacing bins", () => {
    const fractions = profile.shots.histogram.map((b) => b.fraction);
    expect(fractions).toEqual([0, 0.5, 0.4, 0.1, 0, 0]);
  });

  it("classifies rhythm by median shot length", () => {
    expect(rhythmOf(0.8)).toBe("fast-montage");
    expect(rhythmOf(2)).toBe("steady");
    expect(rhythmOf(6)).toBe("slow-burn");
    expect(profile.shots.rhythm).toBe("steady");
  });

  it("measures cut density over the opening, middle and end", () => {
    const front = buildStyleProfile([syntheticAnalysis({ assetId: "f", lengths: [1, 1, 1, 1, 1, 1, 6, 6, 6] })]);
    expect(front.cutDensity.trend).toBe("decelerating");
    expect(front.cutDensity.openingPerMinute).toBeGreaterThan(front.cutDensity.endPerMinute);
    const back = buildStyleProfile([syntheticAnalysis({ assetId: "b", lengths: [6, 6, 6, 1, 1, 1, 1, 1, 1] })]);
    expect(back.cutDensity.trend).toBe("accelerating");
  });

  it("pools several references and keeps only analyses with video", () => {
    const pooled = buildStyleProfile([
      syntheticAnalysis({ assetId: "a", lengths: [1, 1] }),
      syntheticAnalysis({ assetId: "b", lengths: [3, 3] }),
      { ...syntheticAnalysis({ assetId: "audio-only", lengths: [9] }), hasVideo: false },
    ]);
    expect(pooled.sourceIds).toEqual(["a", "b"]);
    expect(pooled.shots.meanSeconds).toBe(2);
    expect(pooled.totalSeconds).toBe(8);
  });

  it("falls back to scene cuts, then to a single shot, and rejects video-less input", () => {
    const base = syntheticAnalysis({ assetId: "c", lengths: [2, 3] });
    expect(buildStyleProfile([{ ...base, shots: [] }]).shots.count).toBe(2);
    expect(buildStyleProfile([{ ...base, shots: [], sceneCuts: [] }]).shots.count).toBe(1);
    expect(() => buildStyleProfile([])).toThrow(/nothing to build/);
  });
});

describe("beat lock", () => {
  it("scores cuts against the tempo grid: all on, all 0.2s off, and a mix", () => {
    const on = buildStyleProfile([syntheticAnalysis({ assetId: "on", lengths: [1, 1.5, 0.5, 2, 1], bpm: 120 })]);
    expect(on.beatLock.score).toBe(1);
    expect(on.beatLock.tempoBpm).toBe(120);
    expect(on.beatLock.beatsAvailable).toBe(true);
    expect(on.beatLock.cutsMeasured).toBe(4);
    const off = buildStyleProfile([syntheticAnalysis({ assetId: "off", lengths: [1, 1.5, 0.5, 2, 1], bpm: 120, phase: 0.2 })]);
    expect(off.beatLock.score).toBe(0);
    const shifted = buildStyleProfile([syntheticAnalysis({ assetId: "x", lengths: [1, 1.5, 0.7, 2, 1], bpm: 120 })]);
    expect(shifted.beatLock.score).toBe(0.5);
  });

  it("reports no beat data without audio timing", () => {
    const profile = buildStyleProfile([syntheticAnalysis({ assetId: "mute", lengths: [1, 2, 3] })]);
    expect(profile.beatLock.beatsAvailable).toBe(false);
    expect(profile.beatLock.score).toBe(0);
    expect(describeStyleProfile(profile)).toContain("no beat data");
  });
});

describe("audio, colour and text", () => {
  it("measures silence ratio, loudness shape and dynamic range", () => {
    const profile = buildStyleProfile([syntheticAnalysis({
      assetId: "a", lengths: [3, 3, 3], levelDb: [-40, -40, -40, -30, -30, -30, -20, -20, -20], silences: [[0, 1.8]],
    })]);
    expect(profile.audio?.silenceRatio).toBeCloseTo(0.2, 12);
    expect(profile.audio?.loudnessShape).toBe("rising");
    expect(profile.audio?.dynamicRangeDb).toBeCloseTo(20, 6);
    expect(buildStyleProfile([syntheticAnalysis({ assetId: "m", lengths: [3] })]).audio).toBeNull();
  });

  it("summarises palette, contrast and saturation from shot colours", () => {
    const bw = buildStyleProfile([syntheticAnalysis({ assetId: "bw", lengths: [1, 1, 1, 1], colors: [["#000000"], ["#ffffff"]] })]);
    expect(bw.colour?.contrast).toBeCloseTo(1, 6);
    expect(bw.colour?.saturation).toBe(0);
    expect(bw.colour?.palette).toHaveLength(2);
    const red = buildStyleProfile([syntheticAnalysis({ assetId: "red", lengths: [1, 1], colors: [["#ff0000"]] })]);
    expect(red.colour?.saturation).toBe(1);
    expect(red.colour?.contrast).toBe(0);
    expect(buildStyleProfile([syntheticAnalysis({ assetId: "none", lengths: [1] })]).colour).toBeNull();
  });

  it("derives text density only when text clips are supplied", () => {
    const analysis = syntheticAnalysis({ assetId: "t", lengths: [30, 30] });
    expect(buildStyleProfile([analysis]).text).toBeNull();
    const text = buildStyleProfile([analysis], { textClips: [{ start: 0, end: 3 }, { start: 2, end: 5 }, { start: 30, end: 33 }] }).text;
    expect(text?.clipsPerMinute).toBe(3);
    expect(text?.meanDurationSeconds).toBe(3);
    expect(text?.coverage).toBeCloseTo(8 / 60, 12);
  });
});

describe("describeStyleProfile", () => {
  it("stays within roughly 250 tokens even with every section present", () => {
    const profile = buildStyleProfile(
      [syntheticAnalysis({ assetId: "full", lengths, bpm: 120, colors: [["#102030", "#a0b0c0"]], levelDb: [-30, -20, -25, -22, -40, -35] })],
      { textClips: [{ start: 0, end: 2 }] },
    );
    const text = describeStyleProfile(profile);
    expect(text).toContain("steady");
    expect(text).toContain("median 1.5s");
    expect(text).toContain("Beat lock");
    expect(text.length).toBeLessThan(1000);
    expect(text.split(/\s+/).length).toBeLessThan(170);
  });
});

describe("compareToProfile", () => {
  const profile = buildStyleProfile([syntheticAnalysis({ assetId: "ref", lengths: [1.5, 2, 2, 2, 2.5].map((x) => x * 0.9), bpm: 120 })]);
  const tracks = (clips: Array<[number, number]>): TimelineTrackInput[] => [
    { id: "main", kind: "video", clips: clips.map(([start, end], i) => ({ id: `c${i}`, start, end })) },
  ];

  it("reports slow pacing against a fast target with both numbers", () => {
    const slow = tracks([[0, 4], [4, 8.4], [8.4, 12.6]]);
    const result = compareToProfile(analyzeTimelinePacing(slow), profile, { shotStarts: [0, 4, 8.4] });
    const average = result.deltas.find((d) => d.metric === "averageShotSeconds");
    expect(average?.withinTolerance).toBe(false);
    expect(average?.message).toBe("average shot 4.2s vs target 1.8s (+133%)");
    expect(result.deltas.find((d) => d.metric === "hookSeconds")?.withinTolerance).toBe(false);
    expect(result.matchScore).toBeLessThan(0.5);
  });

  it("reports the share of cuts on the beat and ignores beat lock when no beats are given", () => {
    const timeline = analyzeTimelinePacing(tracks([[0, 1], [1.2, 2.2], [2.4, 3.4], [3.5, 4.5], [5, 6]]));
    const beats = Array.from({ length: 20 }, (_, i) => i * 0.5);
    const starts = [0, 1.2, 2.4, 3.5, 5];
    const locked = buildStyleProfile([syntheticAnalysis({ assetId: "locked", lengths: [1, 1.5, 0.5, 2, 1], bpm: 120 })]);
    const result = compareToProfile(timeline, locked, { shotStarts: starts, beats });
    const lock = result.deltas.find((d) => d.metric === "beatLockScore");
    expect(lock?.actual).toBe(0.5);
    expect(lock?.target).toBe(1);
    expect(lock?.message).toBe("only 50% of cuts within 80ms of a beat vs 100%");
    expect(compareToProfile(timeline, profile, { shotStarts: starts }).deltas.some((d) => d.metric === "beatLockScore")).toBe(false);
  });

  it("matches a timeline cut exactly like the reference", () => {
    const same = tracks([[0, 1.35], [1.35, 3.15], [3.15, 4.95], [4.95, 6.75], [6.75, 9]]);
    const result = compareToProfile(analyzeTimelinePacing(same), profile, { shotStarts: [0, 1.35, 3.15, 4.95, 6.75] });
    expect(result.deltas.filter((d) => d.metric !== "beatLockScore").every((d) => d.withinTolerance)).toBe(true);
  });
});
