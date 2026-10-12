import { describe, expect, it } from "vitest";
import { adjustPlan, buildFramePlan, type MediaLayer } from "#/engine/render";
import { EFFECT_DEFINITIONS, FILTER_PRESETS, FILTER_PRESET_IDS, limitsOfDefinitions, type Effect, type VideoElement } from "#/engine/model";
import { allElements } from "#/engine/timeline";
import { setupAgent } from "./agent-harness";
import { sec, tracksWith, video, videoAsset } from "./helpers";

const effectsOf = (h: ReturnType<typeof setupAgent>, id: string): Effect[] =>
  ((allElements(h.editor.tracks()).find((l) => l.element.id === id)?.element as VideoElement).effects ?? []);

describe("adjustPlan", () => {
  it("is null for neutral parameters", () => {
    expect(adjustPlan({})).toBeNull();
    expect(adjustPlan({ brightness: 0, contrast: 0, vignette: 0 })).toBeNull();
  });
  it("maps light, contrast and saturation to a GPU filter chain", () => {
    expect(adjustPlan({ brightness: 50, contrast: -20, saturation: 100 })?.filter).toBe("brightness(1.5) contrast(0.8) saturate(2)");
    expect(adjustPlan({ exposure: 50 })?.filter).toBe("brightness(2)");
  });
  it("turns temperature and tint into casts with the right hue, vignette and sharpen into strengths", () => {
    const warm = adjustPlan({ temperature: 100 });
    expect(warm?.casts[0]).toMatchObject({ r: 255, alpha: 0.3 });
    const cool = adjustPlan({ temperature: -50, tint: 100 });
    expect(cool?.casts[0]?.b).toBe(255);
    expect(cool?.casts[1]?.r).toBe(255);
    expect(adjustPlan({ vignette: 100, sharpen: 50 })).toMatchObject({ vignette: 0.9, sharpen: 0.5 });
  });
});

describe("filter presets", () => {
  const limits = limitsOfDefinitions(EFFECT_DEFINITIONS.adjust?.params ?? []);
  it("ships the eight named looks, each a legal and visible adjust bundle", () => {
    expect(FILTER_PRESET_IDS).toHaveLength(8);
    for (const id of FILTER_PRESET_IDS) {
      const params = FILTER_PRESETS[id].params as Record<string, number>;
      expect(adjustPlan(params), id).not.toBeNull();
      for (const [key, value] of Object.entries(params)) {
        expect(value, `${id}.${key}`).toBeGreaterThanOrEqual(limits[key]?.min ?? Number.NEGATIVE_INFINITY);
        expect(value, `${id}.${key}`).toBeLessThanOrEqual(limits[key]?.max ?? Number.POSITIVE_INFINITY);
      }
    }
  });
});

describe("frame plan", () => {
  it("carries the adjust effect with its resolved parameters", () => {
    const el = video("a", 0, 4, { effects: [{ id: "e1", type: "adjust", enabled: true, params: { saturation: -100 } }] });
    const plan = buildFramePlan({ tracks: tracksWith({ main: [el] }), canvas: { width: 1920, height: 1080 }, background: { type: "color", color: "#000" }, assets: [videoAsset("asset-a", 4)], time: sec(1) });
    expect((plan.items[0] as MediaLayer).effects).toEqual([{ type: "adjust", params: { saturation: -100 } }]);
  });
});

describe("agent colour tools", () => {
  async function withClips() {
    const h = setupAgent();
    await h.data("insert_media", { assetId: "a1", start: 0 });
    await h.data("insert_text", { text: "Title", start: 0, duration: 3 });
    const tl = await h.data<{ tracks: Array<{ kind?: string; type?: string; elements: Array<{ id: string; type: string }> }> }>("get_timeline");
    const els = tl.tracks.flatMap((t) => t.elements);
    return { h, videoId: els.find((e) => e.type === "video")!.id, textId: els.find((e) => e.type === "text")!.id };
  }
  it("set_color_adjust creates one adjust effect and edits it on later calls, one undo each", async () => {
    const { h, videoId } = await withClips();
    await h.data("set_color_adjust", { elementIds: [videoId], params: { temperature: 30 } });
    await h.data("set_color_adjust", { elementIds: [videoId], params: { saturation: 20 } });
    const adjusts = effectsOf(h, videoId).filter((e) => e.type === "adjust");
    expect(adjusts).toHaveLength(1);
    expect(adjusts[0]?.params).toMatchObject({ temperature: 30, saturation: 20 });
    h.editor.undo();
    expect(effectsOf(h, videoId)[0]?.params).toMatchObject({ temperature: 30, saturation: 0 });
    h.editor.undo();
    expect(effectsOf(h, videoId)).toHaveLength(0);
  });
  it("apply_filter replaces the earlier look, scales by intensity and clears with none", async () => {
    const { h, videoId, textId } = await withClips();
    await h.data("set_color_adjust", { elementIds: [videoId], params: { vignette: 80 } });
    await h.data("apply_filter", { elementIds: [videoId, textId], filter: "warm" });
    expect(effectsOf(h, videoId)[0]?.params).toMatchObject({ temperature: 45, vignette: 0 });
    await h.data("apply_filter", { elementIds: [videoId], filter: "warm", intensity: 0.5 });
    expect(effectsOf(h, videoId)[0]?.params).toMatchObject({ temperature: 23 });
    await h.data("apply_filter", { elementIds: [videoId], filter: "none" });
    expect(effectsOf(h, videoId)).toHaveLength(0);
  });
  it("rejects bad keys, values, unknown filters and audio clips with guidance", async () => {
    const { h, videoId } = await withClips();
    expect((await h.failure("set_color_adjust", { elementIds: [videoId], params: { brigthness: 10 } })).hint).toContain("brightness");
    expect((await h.failure("set_color_adjust", { elementIds: [videoId], params: { brightness: 500 } })).error).toContain("maximum");
    expect((await h.failure("apply_filter", { elementIds: [videoId], filter: "grunge" })).error).toBeTruthy();
    await h.data("insert_media", { assetId: "music", start: 0 });
    const tl = await h.data<{ tracks: Array<{ elements: Array<{ id: string; type: string }> }> }>("get_timeline");
    const audioId = tl.tracks.flatMap((t) => t.elements).find((e) => e.type === "audio")!.id;
    expect((await h.failure("apply_filter", { elementIds: [audioId], filter: "mono" })).error).toContain("audio");
  });
});
