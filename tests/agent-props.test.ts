import { describe, expect, it } from "vitest";
import { allElements } from "#/engine/timeline";
import { setupAgent, tracksOf, type ElementDetail, type InsertedData } from "./agent-harness";

const find = (h: ReturnType<typeof setupAgent>, id: string) => {
  const found = allElements(tracksOf(h.editor)).find((l) => l.element.id === id);
  if (!found) throw new Error(`missing ${id}`);
  return found.element;
};

describe("set_params", () => {
  it("sets real param keys on one clip and on several, across tracks", async () => {
    const h = setupAgent();
    const a = await h.data<InsertedData>("insert_media", { assetId: "a1" });
    const b = await h.data<InsertedData>("insert_media", { assetId: "a2", start: 2 });
    expect(b.trackId).not.toBe(a.trackId);
    await h.data("set_params", { elementId: a.elementId, params: { opacity: 0.5, "transform.positionX": 100, volume: -6, muted: true } });
    expect(find(h, a.elementId).params).toMatchObject({ opacity: 0.5, "transform.positionX": 100, volume: -6, muted: true });
    const many = await h.data<{ updated: unknown[] }>("set_params", { elementIds: [a.elementId, b.elementId], params: { blendMode: "multiply" } });
    expect(many.updated).toHaveLength(2);
    expect(find(h, b.elementId).params.blendMode).toBe("multiply");
  });

  it("sets text and graphic fields", async () => {
    const h = setupAgent();
    const t = await h.data<InsertedData>("insert_text", { text: "x" });
    await h.data("set_params", { elementId: t.elementId, params: { content: "New", fontSize: 30, "background.enabled": true } });
    expect(find(h, t.elementId).params).toMatchObject({ content: "New", fontSize: 30, "background.enabled": true });
    const g = await h.data<InsertedData>("insert_graphic", { shape: "rectangle" });
    await h.data("set_params", { elementId: g.elementId, params: { cornerRadius: 12, fill: "#112233" } });
    expect(find(h, g.elementId).params).toMatchObject({ cornerRadius: 12, fill: "#112233" });
  });

  it("writes a keyframe at the playhead when the key is already animated", async () => {
    const h = setupAgent();
    const a = await h.data<InsertedData>("insert_media", { assetId: "a1" });
    await h.data("add_keyframe", { elementId: a.elementId, property: "opacity", time: 0, value: 1 });
    await h.data("seek", { time: 4 });
    const r = await h.data<{ updated: Array<{ keyframedAtPlayhead: string[] }> }>("set_params", { elementId: a.elementId, params: { opacity: 0.2, volume: -3 } });
    expect(r.updated[0]?.keyframedAtPlayhead).toEqual(["opacity"]);
    const el = await h.data<ElementDetail>("get_element", { elementId: a.elementId });
    expect(el.animations.opacity?.keyframes.map((k) => k.time)).toEqual([0, 4]);
    expect(el.params.opacity).toBe(1);
    expect(el.params.volume).toBe(-3);
  });

  it("failure: unknown key names the valid keys, out-of-range value, wrong kind, bad shape", async () => {
    const h = setupAgent();
    const a = await h.data<InsertedData>("insert_media", { assetId: "a1" });
    const before = h.editor.getState().revision;
    const key = await h.failure("set_params", { elementId: a.elementId, params: { opacty: 0.5 } });
    expect(key.hint).toContain('Did you mean "opacity"');
    expect(key.hint).toContain("transform.positionX");
    const range = await h.failure("set_params", { elementId: a.elementId, params: { opacity: 3 } });
    expect(range.error).toContain("maximum 1");
    const kind = await h.failure("set_params", { elementId: a.elementId, params: { content: "nope" } });
    expect(kind.error).toContain("video");
    expect((await h.failure("set_params", { params: { opacity: 1 } })).error).toContain("exactly one");
    expect((await h.failure("set_params", { elementId: a.elementId, params: { blendMode: "wavy" } })).error).toContain("blendMode");
    expect(h.editor.getState().revision).toBe(before);
  });

  it("is all-or-nothing across several clips", async () => {
    const h = setupAgent();
    const a = await h.data<InsertedData>("insert_media", { assetId: "a1" });
    const t = await h.data<InsertedData>("insert_text", { text: "x" });
    await h.failure("set_params", { elementIds: [a.elementId, t.elementId], params: { fontSize: 20 } });
    expect(find(h, t.elementId).params.fontSize).toBe(15);
    expect(find(h, a.elementId).params.fontSize).toBeUndefined();
  });
});

describe("keyframes", () => {
  it("add_keyframe snaps the time, reports the id and supports interpolation", async () => {
    const h = setupAgent();
    const a = await h.data<InsertedData>("insert_media", { assetId: "a1" });
    const k = await h.data<{ keyframeId: string; time: number; localTime: number; keyframeCount: number }>("add_keyframe", {
      elementId: a.elementId, property: "transform.scaleX", time: 2.01, value: 1.5, interpolation: "hold",
    });
    expect(k.time).toBe(2);
    expect(k.keyframeId).toEqual(expect.any(String));
    const k2 = await h.data<{ keyframeCount: number }>("add_keyframe", { elementId: a.elementId, property: "transform.scaleX", time: 5, value: 2 });
    expect(k2.keyframeCount).toBe(2);
  });

  it("keyframes use timeline time even for a clip that starts later", async () => {
    const h = setupAgent();
    await h.data("insert_media", { assetId: "a1" });
    const t = await h.data<InsertedData>("insert_text", { text: "x", start: 3, duration: 4 });
    const k = await h.data<{ localTime: number; time: number }>("add_keyframe", { elementId: t.elementId, property: "opacity", time: 4, value: 0 });
    expect(k).toMatchObject({ time: 4, localTime: 1 });
  });

  it("add_keyframe failures: outside the clip, bad property, bad value", async () => {
    const h = setupAgent();
    const a = await h.data<InsertedData>("insert_media", { assetId: "a1" });
    const outside = await h.failure("add_keyframe", { elementId: a.elementId, property: "opacity", time: 11, value: 1 });
    expect(outside.error).toContain("outside clip");
    const prop = await h.failure("add_keyframe", { elementId: a.elementId, property: "fontSize", time: 1, value: 1 });
    expect(prop.hint).toContain("opacity");
    expect((await h.failure("add_keyframe", { elementId: a.elementId, property: "opacity", time: 1, value: 7 })).error).toContain("maximum");
  });

  it("remove_keyframe by id and by time; the last removal bakes the value", async () => {
    const h = setupAgent();
    const a = await h.data<InsertedData>("insert_media", { assetId: "a1" });
    const k1 = await h.data<{ keyframeId: string }>("add_keyframe", { elementId: a.elementId, property: "opacity", time: 0, value: 0 });
    await h.data("add_keyframe", { elementId: a.elementId, property: "opacity", time: 4, value: 0.8 });
    const first = await h.data<{ remaining: number }>("remove_keyframe", { elementId: a.elementId, property: "opacity", keyframeId: k1.keyframeId });
    expect(first.remaining).toBe(1);
    const last = await h.data<{ remaining: number }>("remove_keyframe", { elementId: a.elementId, property: "opacity", time: 4 });
    expect(last.remaining).toBe(0);
    const el = find(h, a.elementId);
    expect(el.animations?.opacity).toBeUndefined();
    expect(el.params.opacity).toBe(0.8);
  });

  it("remove_keyframe failures list what exists", async () => {
    const h = setupAgent();
    const a = await h.data<InsertedData>("insert_media", { assetId: "a1" });
    expect((await h.failure("remove_keyframe", { elementId: a.elementId, property: "opacity", time: 1 })).error).toContain("no keyframes");
    await h.data("add_keyframe", { elementId: a.elementId, property: "opacity", time: 1, value: 0.5 });
    const miss = await h.failure("remove_keyframe", { elementId: a.elementId, property: "opacity", time: 2 });
    expect(miss.hint).toContain("@ 1s");
    await h.failure("remove_keyframe", { elementId: a.elementId, property: "opacity" });
  });
});

describe("effects and masks", () => {
  it("add_effect / set_effect_params / remove_effect", async () => {
    const h = setupAgent();
    const a = await h.data<InsertedData>("insert_media", { assetId: "a1" });
    const fx = await h.data<{ effectId: string; params: Record<string, number> }>("add_effect", { elementId: a.elementId, effectType: "blur" });
    expect(fx.params.intensity).toBe(15);
    const set = await h.data<{ params: Record<string, number>; enabled: boolean }>("set_effect_params", { elementId: a.elementId, effectId: fx.effectId, params: { intensity: 60 }, enabled: false });
    expect(set).toMatchObject({ params: { intensity: 60 }, enabled: false });
    await h.data("remove_effect", { elementId: a.elementId, effectId: fx.effectId });
    expect((find(h, a.elementId) as { effects?: unknown[] }).effects).toEqual([]);
  });

  it("effect failures: audio clip, unknown effect id, bad param", async () => {
    const h = setupAgent();
    const a = await h.data<InsertedData>("insert_media", { assetId: "a1" });
    const m = await h.data<InsertedData>("insert_media", { assetId: "music" });
    expect((await h.failure("add_effect", { elementId: m.elementId, effectType: "blur" })).hint).toContain("insert_effect_layer");
    expect((await h.failure("add_effect", { elementId: a.elementId, effectType: "glitch" })).error).toContain("effectType");
    const fx = await h.data<{ effectId: string }>("add_effect", { elementId: a.elementId, effectType: "blur" });
    expect((await h.failure("remove_effect", { elementId: a.elementId, effectId: "x" })).hint).toContain(fx.effectId);
    expect((await h.failure("set_effect_params", { elementId: a.elementId, effectId: fx.effectId, params: { intensity: 500 } })).error).toContain("maximum 100");
    expect((await h.failure("set_effect_params", { elementId: a.elementId, effectId: fx.effectId })).error).toContain("Nothing");
  });

  it("add_mask with params and remove_mask", async () => {
    const h = setupAgent();
    const a = await h.data<InsertedData>("insert_media", { assetId: "a1" });
    const mask = await h.data<{ maskId: string; params: Record<string, number> }>("add_mask", { elementId: a.elementId, maskType: "rectangle", params: { feather: 20, width: 0.5 } });
    expect(mask.params).toMatchObject({ feather: 20, width: 0.5 });
    await h.data("remove_mask", { elementId: a.elementId, maskId: mask.maskId });
    expect((find(h, a.elementId) as { masks?: unknown[] }).masks).toEqual([]);
  });

  it("mask failures: text clip, unknown mask id, bad param, bad type", async () => {
    const h = setupAgent();
    const a = await h.data<InsertedData>("insert_media", { assetId: "a1" });
    const t = await h.data<InsertedData>("insert_text", { text: "x" });
    expect((await h.failure("add_mask", { elementId: t.elementId, maskType: "ellipse" })).error).toContain("text");
    expect((await h.failure("add_mask", { elementId: a.elementId, maskType: "blob" })).error).toContain("maskType");
    expect((await h.failure("add_mask", { elementId: a.elementId, maskType: "ellipse", params: { feathr: 1 } })).hint).toContain("feather");
    expect((await h.failure("remove_mask", { elementId: a.elementId, maskId: "nope" })).error).toContain("nope");
  });
});
