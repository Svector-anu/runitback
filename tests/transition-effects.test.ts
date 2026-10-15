import { describe, expect, it } from "vitest";
import { TRANSITION_TYPES } from "#/engine/model";
import { buildFramePlan, glitchLook, isTransitionLayerVisible, transitionLook, GLITCH_BAND_COUNT, TRANSITION_BLUR_INTENSITY, type MediaLayer } from "#/engine/render";
import { TRANSITION_NAMES } from "#/engine/timeline";
import { setupAgent } from "./agent-harness";
import { sec, tracksWith, video, videoAsset } from "./helpers";

describe("blur dissolve", () => {
  it("fades the incoming clip in while both clips pass through blur, sharpest at their own end", () => {
    const out = (progress: number) => transitionLook({ type: "blur", role: "out", progress });
    const incoming = (progress: number) => transitionLook({ type: "blur", role: "in", progress });
    expect(out(0).blur).toBe(0);
    expect(out(1).blur).toBe(1);
    expect(incoming(0).blur).toBe(1);
    expect(incoming(1).blur).toBe(0);
    expect(incoming(0.25).alpha).toBe(0.25);
    expect(out(0.25).alpha).toBe(1);
    expect(isTransitionLayerVisible({ type: "blur", role: "out", progress: 0.9 })).toBe(true);
    expect(TRANSITION_BLUR_INTENSITY).toBeLessThanOrEqual(100);
  });
});

describe("flash", () => {
  it("shows one clip per half and washes each toward white at the cut", () => {
    expect(isTransitionLayerVisible({ type: "flash", role: "out", progress: 0.49 })).toBe(true);
    expect(isTransitionLayerVisible({ type: "flash", role: "in", progress: 0.49 })).toBe(false);
    expect(isTransitionLayerVisible({ type: "flash", role: "in", progress: 0.5 })).toBe(true);
    expect(transitionLook({ type: "flash", role: "out", progress: 0 }).lightness).toBe(0);
    expect(transitionLook({ type: "flash", role: "out", progress: 0.5 }).lightness).toBe(1);
    expect(transitionLook({ type: "flash", role: "in", progress: 0.5 }).lightness).toBe(1);
    expect(transitionLook({ type: "flash", role: "in", progress: 1 }).lightness).toBe(0);
    expect(transitionLook({ type: "flash", role: "in", progress: 0.5 }).darkness).toBe(0);
  });
});

describe("glitch", () => {
  it("is clean at both ends and strongest in the middle", () => {
    expect(glitchLook(0)).toBeNull();
    expect(glitchLook(1)).toBeNull();
    const peak = glitchLook(0.5);
    expect(peak?.split).toBeGreaterThan(0.01);
    const shifts = (look: ReturnType<typeof glitchLook>): number => (look?.bands ?? []).reduce((sum, b) => sum + Math.abs(b.shiftX), 0);
    expect(shifts(glitchLook(0.5))).toBeGreaterThan(shifts(glitchLook(0.05)));
  });
  it("slices the frame into ordered bands that cover it exactly", () => {
    for (const progress of [0.1, 0.33, 0.5, 0.72, 0.95]) {
      const bands = glitchLook(progress)?.bands ?? [];
      expect(bands).toHaveLength(GLITCH_BAND_COUNT);
      expect(bands[0]?.from).toBe(0);
      expect(bands.at(-1)?.to).toBe(1);
      bands.forEach((band, i) => {
        expect(band.to).toBeGreaterThanOrEqual(band.from);
        if (i > 0) expect(band.from).toBe(bands[i - 1]?.to);
        expect(Math.abs(band.shiftX)).toBeLessThan(0.1);
      });
    }
  });
  it("is deterministic so preview and export draw the same frame, and changes between steps", () => {
    expect(glitchLook(0.37)).toEqual(glitchLook(0.37));
    expect(glitchLook(0.5)?.bands).not.toEqual(glitchLook(0.9)?.bands);
  });
  it("shows one clip per half and applies to the incoming layer through the plan", () => {
    expect(isTransitionLayerVisible({ type: "glitch", role: "in", progress: 0.4 })).toBe(false);
    expect(isTransitionLayerVisible({ type: "glitch", role: "out", progress: 0.6 })).toBe(false);
    const tracks = tracksWith({ main: [video("a", 0, 4), video("b", 4, 4, { transition: { type: "glitch", duration: sec(1) } })] });
    const assets = [videoAsset("asset-a"), videoAsset("asset-b")];
    const plan = (time: number) => buildFramePlan({ tracks, canvas: { width: 1920, height: 1080 }, background: { type: "color", color: "#000" }, assets, time });
    const items = plan(sec(3.8)).items as MediaLayer[];
    expect(items.map((i) => i.elementId)).toEqual(["a"]);
    expect(items[0]?.transition?.type).toBe("glitch");
    expect((plan(sec(4.2)).items as MediaLayer[]).map((i) => i.elementId)).toEqual(["b"]);
  });
});

describe("registry", () => {
  it("every transition has a name, and the agent accepts the new ones", async () => {
    for (const type of TRANSITION_TYPES) expect(TRANSITION_NAMES[type].length).toBeGreaterThan(0);
    expect(TRANSITION_TYPES).toEqual(expect.arrayContaining(["blur", "flash", "glitch"]));
    const h = setupAgent();
    const a = await h.data<{ elementId: string; end: number }>("insert_media", { assetId: "a1" });
    const b = await h.data<{ elementId: string }>("insert_media", { assetId: "a2" });
    for (const type of ["blur", "flash", "glitch"]) {
      const out = await h.data<{ transitions: Array<{ type: string }> }>("add_transition", { fromElementId: a.elementId, toElementId: b.elementId, type, duration: 0.6 });
      expect(out).toBeTruthy();
    }
    expect((await h.failure("add_transition", { fromElementId: a.elementId, toElementId: b.elementId, type: "swirl" })).error.length).toBeGreaterThan(0);
  });
});
