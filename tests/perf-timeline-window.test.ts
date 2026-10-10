import { describe, expect, it } from "vitest";
import { clipWindow, intersectsWindow } from "#/ui/timeline/layout";

describe("timeline clip windowing", () => {
  it("covers the viewport plus half a viewport of overscan on each side", () => {
    expect(clipWindow({ scrollLeft: 2000, viewportWidth: 1000 })).toEqual({ start: 1500, end: 3500 });
  });

  it("keeps a minimum overscan for very narrow viewports", () => {
    expect(clipWindow({ scrollLeft: 0, viewportWidth: 100 })).toEqual({ start: -200, end: 300 });
  });

  it("mounts only clips touching the window", () => {
    const window = clipWindow({ scrollLeft: 5000, viewportWidth: 1000 });
    const clips = Array.from({ length: 200 }, (_, i) => ({ startPx: i * 100, endPx: i * 100 + 80 }));
    const mounted = clips.filter((c) => intersectsWindow({ ...c, window }));
    expect(mounted.length).toBeLessThan(clips.length / 5);
    expect(mounted.every((c) => c.endPx >= 4500 && c.startPx <= 6500)).toBe(true);
  });

  it("treats a clip that straddles a window edge as visible", () => {
    const window = { start: 100, end: 200 };
    expect(intersectsWindow({ startPx: 50, endPx: 120, window })).toBe(true);
    expect(intersectsWindow({ startPx: 190, endPx: 400, window })).toBe(true);
    expect(intersectsWindow({ startPx: 0, endPx: 99, window })).toBe(false);
    expect(intersectsWindow({ startPx: 201, endPx: 300, window })).toBe(false);
  });
});
