import { describe, expect, it } from "vitest";
import { exportFileName, planExport } from "#/export/plan";
import { sec } from "./helpers";

const fps = (n: number, d = 1) => ({ numerator: n, denominator: d });

describe("planExport", () => {
  it("frame count covers the whole timeline, including a partial last frame", () => {
    expect(planExport({ durationTicks: sec(10), fps: fps(30), canvas: { width: 1920, height: 1080 } }).frameCount).toBe(300);
    expect(planExport({ durationTicks: sec(10) + 1, fps: fps(30), canvas: { width: 1920, height: 1080 } }).frameCount).toBe(301);
    expect(planExport({ durationTicks: 1, fps: fps(30), canvas: { width: 1920, height: 1080 } }).frameCount).toBe(1);
    expect(planExport({ durationTicks: 0, fps: fps(30), canvas: { width: 1920, height: 1080 } }).frameCount).toBe(0);
  });
  it("NTSC rates produce exact frame durations", () => {
    const plan = planExport({ durationTicks: sec(1), fps: fps(30000, 1001), canvas: { width: 1920, height: 1080 } });
    expect(plan.frameCount).toBe(30);
    expect(plan.frameDurationSeconds).toBeCloseTo(1001 / 30000, 6);
  });
  it("rounds canvas to even dimensions for encoders", () => {
    const plan = planExport({ durationTicks: sec(1), fps: fps(30), canvas: { width: 1079, height: 607 } });
    expect(plan.width % 2).toBe(0);
    expect(plan.height % 2).toBe(0);
  });
  it("file names are safe", () => {
    expect(exportFileName("My: Great/Video?", "mp4")).toBe("My- Great-Video-.mp4");
    expect(exportFileName("   ", "webm")).toBe("export.webm");
  });
});
