import { describe, expect, it } from "vitest";
import { DecodeScales } from "#/export/decode-scale";
import { PARAM } from "#/engine/model";
import { buildFramePlan, type FramePlan } from "#/engine/render";
import { sec, tracksWith, video, videoAsset } from "./helpers";

function planAt(input: { canvas: { width: number; height: number }; elements: ReturnType<typeof video>[]; time?: number }): FramePlan {
  return buildFramePlan({
    tracks: tracksWith({ main: input.elements }), canvas: input.canvas, background: { type: "color", color: "#000" },
    assets: input.elements.map((el) => videoAsset(`asset-${el.id}`, 4)), time: sec(input.time ?? 1),
  });
}

describe("DecodeScales", () => {
  it("decodes a source that is drawn smaller than it is at that smaller size", () => {
    const scales = new DecodeScales();
    scales.observe(planAt({ canvas: { width: 960, height: 540 }, elements: [video("a", 0, 4)] }));
    expect(scales.scaleFor("asset-a")).toBeCloseTo(0.5, 5);
  });

  it("keeps full size when the source is drawn at or near its own size", () => {
    const scales = new DecodeScales();
    scales.observe(planAt({ canvas: { width: 1920, height: 1080 }, elements: [video("a", 0, 4)] }));
    scales.observe(planAt({ canvas: { width: 1920, height: 1080 }, elements: [video("b", 0, 4)] }));
    expect(scales.scaleFor("asset-a")).toBe(1);
    expect(scales.scaleFor("asset-b")).toBe(1);
  });

  it("uses the largest size the source is ever drawn at, so a zoom later in the clip keeps its detail", () => {
    const scales = new DecodeScales();
    const small = video("a", 0, 4);
    const zoomed = video("a", 0, 4, { params: { ...small.params, [PARAM.scaleX]: 2, [PARAM.scaleY]: 2 } });
    scales.observe(planAt({ canvas: { width: 960, height: 540 }, elements: [small], time: 0 }));
    expect(scales.scaleFor("asset-a")).toBeCloseTo(0.5, 5);
    scales.observe(planAt({ canvas: { width: 960, height: 540 }, elements: [zoomed], time: 2 }));
    expect(scales.scaleFor("asset-a")).toBe(1);
  });

  it("is unaffected by crop, which draws the remaining part where it was rather than enlarging it", () => {
    const scales = new DecodeScales();
    const base = video("a", 0, 4);
    const cropped = { ...base, params: { ...base.params, [PARAM.cropLeft]: 0.25, [PARAM.cropRight]: 0.25 } };
    scales.observe(planAt({ canvas: { width: 960, height: 540 }, elements: [cropped] }));
    expect(scales.scaleFor("asset-a")).toBeCloseTo(0.5, 5);
  });

  it("never goes below the minimum and treats unseen sources as full size", () => {
    const scales = new DecodeScales();
    scales.observe(planAt({ canvas: { width: 100, height: 56 }, elements: [video("a", 0, 4)] }));
    expect(scales.scaleFor("asset-a")).toBe(0.1);
    expect(scales.scaleFor("never-drawn")).toBe(1);
  });
});
