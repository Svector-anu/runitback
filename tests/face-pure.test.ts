import { describe, expect, it } from "vitest";
import {
  boxArea, faceFocusPath, faceShotStats, findFaceMoments, focusAt, focusTransform, iou, maxCrop, regionOf, trackFaces, type FocusPoint,
} from "#/engine/face";
import { buildTemporalIndex, describeIndex } from "#/engine/temporal";
import { A1_CUTS, A1_FACE_FRAMES, box, detections, frame, speaker } from "./face-harness";
import { makeAnalysis } from "./temporal-harness";

const rounded = (moments: Array<{ startSeconds: number; endSeconds: number }>): Array<[number, number]> =>
  moments.map((m) => [Math.round(m.startSeconds * 1000) / 1000, Math.round(m.endSeconds * 1000) / 1000]);

describe("geometry", () => {
  it("computes IoU: identical 1, disjoint 0, half-overlap 1/3", () => {
    expect(iou(box(0.1, 0.1, 0.2, 0.2), box(0.1, 0.1, 0.2, 0.2))).toBeCloseTo(1, 9);
    expect(iou(box(0, 0, 0.1, 0.1), box(0.5, 0.5, 0.1, 0.1))).toBe(0);
    expect(iou(box(0, 0, 0.2, 0.2), box(0.1, 0, 0.2, 0.2))).toBeCloseTo(1 / 3, 9);
  });

  it("puts a box in the third its centre lies in", () => {
    expect([0.1, 0.4, 0.9].map((cx) => regionOf(speaker(cx)))).toEqual(["left", "center", "right"]);
    expect(regionOf(box(0, 0, 0.7, 0.1))).toBe("center");
  });
});

describe("trackFaces", () => {
  it("keeps one id while a face drifts and smooths the box with the running average", () => {
    const tracked = trackFaces(detections({ frames: [frame(1, box(0.2, 0.2, 0.2, 0.2)), frame(3, box(0.25, 0.2, 0.2, 0.2))] }), { smoothing: 0.5 });
    expect(tracked.map((f) => f.faces.map((x) => x.id))).toEqual([[1], [1]]);
    expect(tracked[1]?.faces[0]?.x).toBeCloseTo(0.225, 9);
    expect(tracked[1]?.faces[0]?.width).toBeCloseTo(0.2, 9);
  });

  it("gives a far-away second face its own id and never swaps ids between two faces", () => {
    const left = (dx: number) => box(0.1 + dx, 0.3, 0.15, 0.2);
    const right = (dx: number) => box(0.7 - dx, 0.3, 0.15, 0.2);
    const tracked = trackFaces(detections({ frames: [frame(1, left(0), right(0)), frame(3, right(0.03), left(0.03)), frame(5, left(0.05), right(0.05))] }));
    for (const f of tracked) {
      const byX = [...f.faces].sort((a, b) => a.x - b.x).map((x) => x.id);
      expect(byX).toEqual([1, 2]);
    }
  });

  it("bridges one missed frame, then drops the track and never reuses its id", () => {
    const f = box(0.4, 0.3, 0.2, 0.3);
    const bridged = trackFaces(detections({ frames: [frame(1, f), frame(3), frame(5, f)] }));
    expect(bridged[2]?.faces.map((x) => x.id)).toEqual([1]);
    const dropped = trackFaces(detections({ frames: [frame(1, f), frame(3), frame(5), frame(7, f)] }));
    expect(dropped[3]?.faces.map((x) => x.id)).toEqual([2]);
  });

  it("is deterministic and handles empty input", () => {
    expect(trackFaces(detections({ frames: [] }))).toEqual([]);
    const input = detections({ frames: A1_FACE_FRAMES });
    expect(trackFaces(input)).toEqual(trackFaces(input));
  });
});

describe("findFaceMoments", () => {
  const d = detections({ frames: A1_FACE_FRAMES });

  it("merges touching frames into presence moments; each frame stands for the span to its neighbours", () => {
    expect(rounded(findFaceMoments({ detections: d }))).toEqual([[0, 4], [6, 10]]);
  });

  it("finds absence", () => {
    expect(rounded(findFaceMoments({ detections: d, query: { present: false } }))).toEqual([[4, 6]]);
  });

  it("filters by face count", () => {
    expect(rounded(findFaceMoments({ detections: d, query: { minFaces: 2 } }))).toEqual([[6, 8]]);
    expect(rounded(findFaceMoments({ detections: d, query: { maxFaces: 1 } }))).toEqual([[0, 4], [8, 10]]);
  });

  it("filters by size and region, counting only qualifying faces", () => {
    const sized = detections({ frames: [frame(1, box(0.3, 0.2, 0.1, 0.1)), frame(3, box(0.3, 0.2, 0.3, 0.4)), frame(5, box(0.3, 0.2, 0.1, 0.1))] });
    expect(rounded(findFaceMoments({ detections: sized, query: { minSize: 0.3 } }))).toEqual([[2, 4]]);
    expect(rounded(findFaceMoments({ detections: d, query: { region: "right" } }))).toEqual([[6, 10]]);
    expect(rounded(findFaceMoments({ detections: d, query: { region: "right", minFaces: 2 } }))).toEqual([]);
    expect(rounded(findFaceMoments({ detections: d, query: { region: "center", present: false } }))).toEqual([[0, 10]]);
  });

  it("reports the longest continuous presence first and honours limit, minDuration and range", () => {
    expect(rounded(findFaceMoments({ detections: d, query: { sort: "longest", limit: 1 } }))).toEqual([[0, 4]]);
    expect(rounded(findFaceMoments({ detections: d, query: { minDurationSeconds: 4 } }))).toEqual([[0, 4], [6, 10]]);
    expect(rounded(findFaceMoments({ detections: d, query: { minDurationSeconds: 4.5 } }))).toEqual([]);
    expect(rounded(findFaceMoments({ detections: d, query: { sourceRange: { startSeconds: 2, endSeconds: 7 } } }))).toEqual([[2, 4], [6, 7]]);
  });

  it("does not let a frame stand for footage across a scene cut", () => {
    const one = detections({ frames: [frame(1, speaker(0.5)), frame(5)] });
    expect(rounded(findFaceMoments({ detections: one }))).toEqual([[0, 3]]);
    expect(rounded(findFaceMoments({ detections: one, cuts: [2] }))).toEqual([[0, 2]]);
  });

  it("reports counts and sizes on each moment", () => {
    const [first, second] = findFaceMoments({ detections: d });
    expect(first).toMatchObject({ frames: 2, maxFaces: 1, meanFaces: 1 });
    expect(second).toMatchObject({ frames: 2, maxFaces: 2, meanFaces: 1.5 });
    expect(second?.largestSize).toBeCloseTo(0.2, 9);
  });
});

describe("faceShotStats", () => {
  it("summarises presence, count, biggest face and dominant side per shot", () => {
    const shots = [{ startSeconds: 0, endSeconds: 4 }, { startSeconds: 4, endSeconds: 8 }, { startSeconds: 8, endSeconds: 10 }];
    const stats = faceShotStats({ detections: detections({ frames: A1_FACE_FRAMES }), spans: shots });
    expect(stats.map((s) => [s.framesSampled, s.presentRatio, s.meanCount, s.dominantPosition])).toEqual([[2, 1, 1, "left"], [2, 0.5, 1, "left"], [1, 1, 1, "right"]]);
    expect(stats[1]?.largest?.t).toBe(7);
    expect(stats[0] && boxArea(stats[0].largest?.box ?? box(0, 0, 0, 0))).toBeCloseTo(0.024, 9);
  });

  it("reports an unsampled shot honestly and includes the end of the last shot", () => {
    const stats = faceShotStats({ detections: detections({ frames: [frame(10, speaker(0.5))] }), spans: [{ startSeconds: 0, endSeconds: 5 }, { startSeconds: 5, endSeconds: 10 }] });
    expect(stats[0]).toEqual({ framesSampled: 0, presentRatio: 0, meanCount: 0 });
    expect(stats[1]?.framesSampled).toBe(1);
  });
});

describe("faceFocusPath", () => {
  const base = { sourceAspect: 16 / 9, targetAspect: 9 / 16 };
  const steady = (centerX: number, count: number, step = 2) => Array.from({ length: count }, (_, i) => frame(1 + i * step, speaker(centerX)));

  it("has the widest 9:16 window of a 16:9 frame as zoom 1", () => {
    expect(maxCrop(base)).toEqual({ width: expect.closeTo(0.31640625, 9), height: 1 });
    expect(maxCrop({ sourceAspect: 9 / 16, targetAspect: 16 / 9 })).toEqual({ width: 1, height: expect.closeTo(0.31640625, 9) });
  });

  it("returns nothing when no face was ever seen", () => {
    expect(faceFocusPath({ ...base, detections: detections({ frames: [frame(1), frame(3)] }) })).toEqual([]);
  });

  it("centres on a steady speaker (a full-height window cannot move vertically) and collapses to its end points", () => {
    const path = faceFocusPath({ ...base, detections: detections({ frames: steady(0.4, 5) }) });
    expect(path).toHaveLength(2);
    expect(path[0]).toMatchObject({ centerX: expect.closeTo(0.4, 6), centerY: 0.5, hasFace: true });
    expect(path[0]?.cropWidth).toBeCloseTo(0.3164 / path[0]!.zoom, 3);
  });

  it("ignores jitter inside the dead zone but follows a real move, eased", () => {
    const jitter = [0.4, 0.42, 0.39, 0.41, 0.4].map((cx, i) => frame(1 + i * 2, speaker(cx)));
    const calm = faceFocusPath({ ...base, detections: detections({ frames: jitter }) });
    expect(new Set(calm.map((p) => p.centerX.toFixed(4))).size).toBe(1);

    const move = [0.3, 0.3, 0.4, 0.4, 0.4].map((cx, i) => frame(1 + i * 2, speaker(cx)));
    const path = faceFocusPath({ ...base, detections: detections({ frames: move }), zoom: "none" });
    const at = (t: number): number => path.find((p) => p.t === t)?.centerX ?? Number.NaN;
    expect(at(1)).toBeCloseTo(0.3, 6);
    expect(at(5)).toBeGreaterThan(0.3);
    expect(at(5)).toBeLessThan(0.4);
    expect(Math.abs(at(9) - 0.4), "settles within the dead zone of the target").toBeLessThan(0.05);
  });

  it("jumps to a subject who would otherwise be outside the window instead of easing there", () => {
    const frames = [0.2, 0.2, 0.8, 0.8].map((cx, i) => frame(1 + i * 2, speaker(cx)));
    const path = faceFocusPath({ ...base, detections: detections({ frames }), zoom: "none" });
    expect(path.find((p) => p.t === 5)?.centerX).toBeCloseTo(0.8, 6);
    expect(path.find((p) => p.t === 3)?.centerX).toBeCloseTo(0.2, 6);
  });

  it("never lets the window leave the frame", () => {
    const edge = faceFocusPath({ ...base, detections: detections({ frames: [frame(1, speaker(0.02)), frame(3, speaker(0.98))] }), zoom: "none", smoothing: 1 });
    for (const p of edge) {
      expect(p.centerX - p.cropWidth / 2).toBeGreaterThanOrEqual(-1e-9);
      expect(p.centerX + p.cropWidth / 2).toBeLessThanOrEqual(1 + 1e-9);
      expect(p.centerY - p.cropHeight / 2).toBeGreaterThanOrEqual(-1e-9);
      expect(p.centerY + p.cropHeight / 2).toBeLessThanOrEqual(1 + 1e-9);
    }
  });

  it("zooms in on small faces (auto) up to the cap, and never with zoom none", () => {
    const small = detections({ frames: [frame(1, box(0.48, 0.45, 0.04, 0.07)), frame(3, box(0.48, 0.45, 0.04, 0.07))] });
    const auto = faceFocusPath({ ...base, detections: small });
    expect(auto[0]?.zoom).toBeGreaterThan(1.2);
    expect(auto[0]?.zoom).toBeLessThanOrEqual(3);
    expect(faceFocusPath({ ...base, detections: small, zoom: "none" })[0]?.zoom).toBe(1);
    expect(faceFocusPath({ ...base, detections: small, maxZoom: 1.1 })[0]?.zoom).toBeCloseTo(1.1, 9);
  });

  it("holds the last position through a short gap, eases to the middle after a long one, and back-fills before the first face", () => {
    const frames = [frame(1), frame(3, speaker(0.3)), frame(5), frame(7), frame(9), frame(11), frame(13)];
    const path = faceFocusPath({ ...base, detections: detections({ durationSeconds: 14, frames }), zoom: "none", smoothing: 1 });
    expect(path[0]).toMatchObject({ t: 1, hasFace: false });
    expect(path[0]?.centerX).toBeCloseTo(0.3, 6);
    const held = path.find((p) => p.t === 5);
    expect(held?.centerX ?? 0.3).toBeCloseTo(0.3, 6);
    expect(path[path.length - 1]?.centerX).toBeCloseTo(0.5, 6);
  });

  it("sticks to the person it follows unless another face is clearly bigger, and frames everyone with subject all", () => {
    const a = (area: number) => box(0.2, 0.3, 0.1 * area, 0.2 * area);
    const b = (area: number) => box(0.7, 0.3, 0.1 * area, 0.2 * area);
    const frames = [frame(1, a(1), b(0.9)), frame(3, a(1), b(1.1)), frame(5, a(1), b(2))];
    const path = faceFocusPath({ ...base, detections: detections({ frames }), zoom: "none", smoothing: 1, deadZone: 0 });
    expect(path[0]?.centerX).toBeLessThan(0.3);
    expect(path[1]?.centerX).toBeLessThan(0.3);
    expect(path[2]?.centerX).toBeGreaterThan(0.6);
    const all = faceFocusPath({ ...base, detections: detections({ frames: [frame(1, a(1), b(1)), frame(3, a(1), b(1))] }), subject: "all", zoom: "none" });
    expect(all[0]?.centerX).toBeCloseTo(0.5, 2);
  });

  it("interpolates between points with focusAt and holds beyond the ends", () => {
    const path: FocusPoint[] = [
      { t: 2, centerX: 0.3, centerY: 0.5, zoom: 1, cropWidth: 0.3, cropHeight: 1, hasFace: true },
      { t: 4, centerX: 0.5, centerY: 0.5, zoom: 2, cropWidth: 0.15, cropHeight: 0.5, hasFace: true },
    ];
    expect(focusAt(path, 3)).toEqual({ centerX: 0.4, centerY: 0.5, zoom: 1.5 });
    expect(focusAt(path, 0)?.centerX).toBe(0.3);
    expect(focusAt(path, 9)?.zoom).toBe(2);
    expect(focusAt([], 1)).toBeUndefined();
  });
});

describe("focusTransform", () => {
  const source = { width: 1920, height: 1080 };
  const canvas = { width: 1080, height: 1920 };

  it("leaves a centred focus at the origin with the scale that just covers the canvas", () => {
    const t = focusTransform({ focus: { centerX: 0.5, centerY: 0.5, zoom: 1 }, source, canvas });
    expect(t.positionX).toBeCloseTo(0, 9);
    expect(t.positionY).toBeCloseTo(0, 9);
    expect(t.scale).toBeCloseTo(1920 / (1080 * 0.5625), 6);
  });

  it("moves the focus point to the canvas centre", () => {
    const focus = { centerX: 0.6, centerY: 0.5, zoom: 1.5 };
    const t = focusTransform({ focus, source, canvas });
    const shownWidth = 1920 * 0.5625 * t.scale;
    const faceOnCanvas = canvas.width / 2 + t.positionX + (focus.centerX - 0.5) * shownWidth;
    expect(faceOnCanvas).toBeCloseTo(canvas.width / 2, 6);
  });

  it("clamps a focus whose window would leave the frame, so no canvas edge shows background", () => {
    const t = focusTransform({ focus: { centerX: 0.99, centerY: 0.5, zoom: 1 }, source, canvas });
    const shownWidth = 1920 * 0.5625 * t.scale;
    expect(canvas.width / 2 + t.positionX + shownWidth / 2).toBeGreaterThanOrEqual(canvas.width - 1e-6);
  });
});

describe("temporal index with faces", () => {
  const faces = detections({ frames: A1_FACE_FRAMES });
  const analysis = makeAnalysis({ cuts: A1_CUTS });

  it("adds tracks.face events, sources.faces and per-shot stats", () => {
    const index = buildTemporalIndex({ assetId: "a1", duration: 10, analysis, faces });
    expect(index.sources.faces).toBe(true);
    expect(index.shots.map((s) => s.faces?.presentRatio)).toEqual([1, 0.5, 1]);
    expect(index.shots[1]?.faces?.meanCount).toBe(1);
    const events = index.tracks.face ?? [];
    expect(events.map((e) => [e.label, e.startSeconds, e.endSeconds])).toEqual([["face-1", 0, 4], ["face-1", 6, 8], ["face-2", 6, 10]]);
    for (const e of events) {
      expect(e.endSeconds).toBeGreaterThan(e.startSeconds);
      expect(e.score).toBeGreaterThan(0);
    }
    expect(describeIndex(index)).toContain("faces 100% of frames");
  });

  it("leaves everything unchanged when no faces are given", () => {
    const plain = buildTemporalIndex({ assetId: "a1", duration: 10, analysis });
    expect("face" in plain.tracks).toBe(false);
    expect("faces" in plain.sources).toBe(false);
    expect(plain.shots.every((s) => !("faces" in s))).toBe(true);
    const withFaces = buildTemporalIndex({ assetId: "a1", duration: 10, analysis, faces });
    expect({ ...withFaces.tracks, face: undefined }).toEqual({ ...plain.tracks, face: undefined });
    expect(withFaces.shots.map((shot) => ({ ...shot, faces: undefined }))).toEqual(plain.shots.map((shot) => ({ ...shot, faces: undefined })));
  });

  it("splits one tracked face into separate events when it leaves and returns", () => {
    const index = buildTemporalIndex({ assetId: "a1", duration: 10, faces: detections({ frames: [frame(1, speaker(0.3)), frame(3), frame(5), frame(7, speaker(0.3))] }) });
    const [first, second] = index.tracks.face ?? [];
    expect(first?.endSeconds).toBeLessThanOrEqual(2);
    expect(second?.startSeconds).toBeGreaterThanOrEqual(6);
    expect(first?.label).not.toBe(second?.label);
  });
});
