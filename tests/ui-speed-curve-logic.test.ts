import { describe, expect, it } from "vitest";
import { addPoint, MIN_POINT_GAP, movePoint, removePoint, speedAt, speedToY, VIEW_MAX_SPEED, VIEW_MIN_SPEED, yToSpeed } from "#/ui/properties/speed-curve-logic";

const SHAPE = [{ position: 0, speed: 1 }, { position: 0.5, speed: 0.25 }, { position: 1, speed: 1 }];

describe("speed curve editor logic", () => {
  it("maps speed to height on a log scale and back", () => {
    expect(speedToY(VIEW_MAX_SPEED)).toBeCloseTo(0, 6);
    expect(speedToY(VIEW_MIN_SPEED)).toBeCloseTo(1, 6);
    for (const speed of [0.1, 0.25, 0.5, 1, 2, 4, 5]) expect(yToSpeed(speedToY(speed))).toBeCloseTo(speed, 1);
    expect(yToSpeed(-3)).toBe(VIEW_MAX_SPEED);
    expect(yToSpeed(9)).toBe(VIEW_MIN_SPEED);
  });

  it("keeps the end points on the clip edges and inner points between their neighbours", () => {
    expect(movePoint(SHAPE, 0, { position: 0.4, speed: 3 })[0]).toEqual({ position: 0, speed: 3 });
    expect(movePoint(SHAPE, 2, { position: 0.2, speed: 0.5 })[2]).toEqual({ position: 1, speed: 0.5 });
    expect(movePoint(SHAPE, 1, { position: 2, speed: 9 })[1]).toEqual({ position: 1 - MIN_POINT_GAP, speed: VIEW_MAX_SPEED });
    expect(movePoint(SHAPE, 1, { position: -2, speed: 0 })[1]).toEqual({ position: MIN_POINT_GAP, speed: VIEW_MIN_SPEED });
  });

  it("adds points on the line, up to six, never on top of another", () => {
    const added = addPoint(SHAPE, 0.25);
    expect(added?.map((p) => p.position)).toEqual([0, 0.25, 0.5, 1]);
    expect(added?.[1]?.speed).toBeCloseTo(speedAt(SHAPE, 0.25), 1);
    expect(addPoint(SHAPE, 0.51)).toBeNull();
    let shape = SHAPE;
    for (const p of [0.1, 0.2, 0.3]) shape = addPoint(shape, p) ?? shape;
    expect(shape).toHaveLength(6);
    expect(addPoint(shape, 0.8)).toBeNull();
  });

  it("removes only inner points and never goes below two", () => {
    expect(removePoint(SHAPE, 1)).toEqual([SHAPE[0], SHAPE[2]]);
    expect(removePoint(SHAPE, 0)).toBeNull();
    expect(removePoint(SHAPE, 2)).toBeNull();
    expect(removePoint([SHAPE[0]!, SHAPE[2]!], 1)).toBeNull();
  });
});
