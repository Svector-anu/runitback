import { describe, expect, it } from "vitest";
import {
  analyzeTimelinePacing, contactSheetPlan, evenSampleTimes, formatSheetTimecode, timelineLoudness, trackInputsFromScene,
  type TimelineTrackInput,
} from "#/engine/analysis";
import { audio, text, tracksWith, video } from "./helpers";

const clip = (id: string, start: number, end: number, extra: Partial<TimelineTrackInput["clips"][number]> = {}) => ({ id, start, end, ...extra });

describe("analyzeTimelinePacing", () => {
  const tracks: TimelineTrackInput[] = [
    { id: "main", kind: "video", clips: [clip("a", 0, 2), clip("b", 2, 3), clip("c", 5, 13)] },
    { id: "ov", kind: "video", clips: [clip("d", 1, 2.5)] },
    { id: "aud", kind: "audio", clips: [clip("e", 0, 4)] },
  ];

  it("measures lengths, averages, cut rate and histogram", () => {
    const result = analyzeTimelinePacing(tracks);
    expect(result.durationSeconds).toBe(13);
    expect(result.tracks[0]?.cutLengths).toEqual([2, 1, 8]);
    expect(result.tracks[0]?.gapSeconds).toBe(2);
    expect(result.averageShotLength).toBeCloseTo((2 + 1 + 8 + 1.5) / 4, 9);
    expect(result.cutsPerMinute).toBeCloseTo((3 / 13) * 60, 9);
    const counts = result.pacingHistogram.map((b) => b.count);
    expect(counts).toEqual([0, 2, 1, 0, 1, 0]);
    expect(result.pacingHistogram[5]?.maxSeconds).toBeNull();
  });

  it("finds dead air only where neither video nor audio plays", () => {
    const result = analyzeTimelinePacing(tracks);
    expect(result.deadAirRanges).toEqual([{ start: 4, end: 5 }]);
    expect(result.deadAirSeconds).toBe(1);
  });

  it("counts clip overlaps across tracks but not touching edges or same-track neighbours", () => {
    const result = analyzeTimelinePacing(tracks);
    expect(result.overlapCount).toBe(5);
  });

  it("is all zeros for an empty timeline", () => {
    const result = analyzeTimelinePacing([]);
    expect(result).toMatchObject({ durationSeconds: 0, averageShotLength: 0, cutsPerMinute: 0, deadAirSeconds: 0, overlapCount: 0 });
  });

  it("converts engine tracks from ticks to seconds", () => {
    const scene = tracksWith({
      main: [video("m1", 0, 4), video("m2", 4, 6)],
      overlay: [{ id: "t1", type: "text", elements: [text("x", 1, 2)] }],
      audio: [{ id: "a1", elements: [audio("s", 0, 9)] }],
    });
    const inputs = trackInputsFromScene(scene);
    expect(inputs.map((t) => t.kind)).toEqual(["text", "video", "audio"]);
    const result = analyzeTimelinePacing(inputs);
    expect(result.durationSeconds).toBe(10);
    expect(result.averageShotLength).toBe(5);
    expect(result.deadAirSeconds).toBe(0);
  });
});

describe("timelineLoudness", () => {
  const curves = new Map([["m", { windowSeconds: 0.5, db: [-20, -20, -20, -20, -60, -60, -60, -60] }]]);

  it("maps source level through trim and sums overlapping clips as power", () => {
    const result = timelineLoudness({
      tracks: [{ id: "a", kind: "audio", clips: [clip("1", 0, 2, { mediaId: "m", trimStart: 0 }), clip("2", 2, 4, { mediaId: "m", trimStart: 0 })] }],
      curves,
    });
    expect(result.map((w) => Math.round(w.db))).toEqual([-20, -20, -20, -20]);

    const trimmed = timelineLoudness({ tracks: [{ id: "a", kind: "audio", clips: [clip("1", 0, 2, { mediaId: "m", trimStart: 2 })] }], curves });
    expect(trimmed.map((w) => Math.round(w.db))).toEqual([-60, -60]);

    const stacked = timelineLoudness({
      tracks: [
        { id: "a", kind: "audio", clips: [clip("1", 0, 1, { mediaId: "m" })] },
        { id: "b", kind: "audio", clips: [clip("2", 0, 1, { mediaId: "m" })] },
      ],
      curves,
    });
    expect(stacked[0]?.db).toBeCloseTo(-20 + 10 * Math.log10(2), 6);
  });

  it("weights partial windows and reports the floor where nothing plays", () => {
    const result = timelineLoudness({ tracks: [{ id: "a", kind: "audio", clips: [clip("1", 0.5, 1, { mediaId: "m" }), clip("2", 2, 3, { mediaId: "m" })] }], curves });
    expect(result[0]?.db).toBeCloseTo(-20 + 10 * Math.log10(0.5), 6);
    expect(result[1]?.db).toBe(-100);
  });
});

describe("contactSheetPlan", () => {
  it("lays out a grid with timecode labels", () => {
    const plan = contactSheetPlan({ times: [0, 1.5, 61.25, 3], columns: 2, cell: { width: 320, height: 180 }, gap: 4 });
    expect(plan).toMatchObject({ columns: 2, rows: 2, width: 2 * 320 + 3 * 4, height: 2 * 180 + 3 * 4 });
    expect(plan.cells.map((c) => c.label)).toEqual(["00:00.00", "00:01.50", "01:01.25", "00:03.00"]);
    expect(plan.cells[3]).toMatchObject({ x: 4 + 324, y: 4 + 184, width: 320, height: 180 });
  });

  it("scales cells down so the long side never exceeds 1568 px", () => {
    const plan = contactSheetPlan({ times: Array.from({ length: 12 }, (_, i) => i), columns: 4, cell: { width: 640, height: 360 } });
    expect(Math.max(plan.width, plan.height)).toBeLessThanOrEqual(1568);
    expect(plan.cells[0]?.width).toBeLessThan(640);
    expect(plan.cells[0]!.width / plan.cells[0]!.height).toBeCloseTo(16 / 9, 1);
  });

  it("clamps columns to the frame count and keeps small sheets at natural size", () => {
    const plan = contactSheetPlan({ times: [1, 2], columns: 6, cell: { width: 100, height: 50 }, gap: 0 });
    expect(plan).toMatchObject({ columns: 2, rows: 1, width: 200, height: 50 });
  });

  it("samples evenly at slot centres and formats timecodes", () => {
    expect(evenSampleTimes({ start: 0, end: 10, count: 4 })).toEqual([1.25, 3.75, 6.25, 8.75]);
    expect(formatSheetTimecode(125.999)).toBe("02:06.00");
  });
});
