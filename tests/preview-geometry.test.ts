import { describe, expect, it } from "vitest";
import { hitTest, pointInBounds, type ElementBounds } from "#/render/bounds";
import { normalizeDelta, snapPosition, snapRotation } from "#/render/snap";

const box = (id: string, cx: number, cy: number, w: number, h: number, rotationDegrees = 0): ElementBounds => ({ elementId: id, cx, cy, width: w, height: h, rotationDegrees, kind: "media" });

describe("hit testing", () => {
  it("tests points in the element's rotated frame", () => {
    const b = box("a", 100, 100, 200, 20, 90);
    expect(pointInBounds(b, 100, 190)).toBe(true);
    expect(pointInBounds(b, 190, 100)).toBe(false);
  });
  it("picks the topmost element in draw order", () => {
    const list = [box("bottom", 50, 50, 100, 100), box("top", 60, 60, 100, 100)];
    expect(hitTest(list, 55, 55)?.elementId).toBe("top");
    expect(hitTest(list, 5, 5)?.elementId).toBe("bottom");
    expect(hitTest(list, 500, 500)).toBeNull();
  });
});

describe("position snapping", () => {
  const base = { width: 200, height: 100, rotationDegrees: 0, canvasWidth: 1920, canvasHeight: 1080, threshold: 8 };
  it("snaps the centre to the canvas centre", () => {
    expect(snapPosition({ ...base, cx: 5, cy: -3 })).toEqual({ dx: -5, dy: 3, guideX: 0, guideY: 0 });
  });
  it("snaps edges flush to the canvas edge", () => {
    const r = snapPosition({ ...base, cx: 960 - 100 - 4, cy: 300 });
    expect(r.dx).toBe(4);
    expect(r.guideX).toBe(960);
    expect(r.guideY).toBeNull();
  });
  it("uses rotated extents", () => {
    const r = snapPosition({ ...base, rotationDegrees: 90, cx: 960 - 50 - 3, cy: 300 });
    expect(r.dx).toBe(3);
  });
  it("does nothing outside the threshold", () => {
    expect(snapPosition({ ...base, cx: 200, cy: 200 })).toEqual({ dx: 0, dy: 0, guideX: null, guideY: null });
  });
});

describe("rotation", () => {
  it("snaps to quarter turns within 5 degrees only", () => {
    expect(snapRotation(87)).toBe(90);
    expect(snapRotation(94)).toBe(90);
    expect(snapRotation(84)).toBe(84);
    expect(snapRotation(-178)).toBe(-180);
  });
  it("normalises deltas across the wrap", () => {
    expect(normalizeDelta(350)).toBe(-10);
    expect(normalizeDelta(-350)).toBe(10);
    expect(normalizeDelta(180)).toBe(180);
    expect(normalizeDelta(-180)).toBe(180);
  });
});
