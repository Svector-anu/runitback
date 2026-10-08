import { describe, expect, it } from "vitest";
import { ASSETS, setupAgent, tracksOf, type ElementDetail, type InsertedData } from "./agent-harness";

interface TimelineData {
  durationSeconds: number;
  tracks: Array<{ id: string; kind: string; role: string; muted?: boolean; hidden?: boolean; gaps: Array<{ start: number; end: number }>; elements: Array<Record<string, unknown>> }>;
}

describe("read tools", () => {
  it("get_project summarises the project", async () => {
    const h = setupAgent();
    await h.data("insert_media", { assetId: "a1" });
    const p = await h.data<Record<string, unknown>>("get_project");
    expect(p).toMatchObject({ name: "Test", canvas: { width: 1920, height: 1080 }, fps: 30, durationSeconds: 10, trackCount: 1, assetCount: ASSETS.length });
  });

  it("get_timeline lists tracks top to bottom with seconds, flags and gaps", async () => {
    const h = setupAgent();
    await h.data("insert_media", { assetId: "a1" });
    await h.data("insert_media", { assetId: "music", start: 2 });
    const text = await h.data<InsertedData>("insert_text", { text: "Hi", start: 1, duration: 2 });
    await h.data("add_keyframe", { elementId: text.elementId, property: "opacity", time: 1, value: 0 });
    const t = await h.data<TimelineData>("get_timeline");
    expect(t.tracks.map((x) => x.role)).toEqual(["overlay", "main", "audio"]);
    const [overlay, main, audio] = t.tracks;
    expect(overlay?.kind).toBe("text");
    expect(overlay?.elements[0]).toMatchObject({ type: "text", start: 1, end: 3, duration: 2, hasKeyframes: true, hasEffects: false, hasMasks: false, speed: 1 });
    expect((overlay?.elements[0]?.params as Record<string, unknown>).content).toBe("Hi");
    expect(main?.elements[0]).toMatchObject({ start: 0, end: 10, trimStart: 0, assetId: "a1" });
    expect(main?.muted).toBe(false);
    expect(audio?.gaps).toEqual([{ start: 0, end: 2 }]);
    expect(t.durationSeconds).toBe(32);
  });

  it("get_timeline reports gaps between clips", async () => {
    const h = setupAgent();
    const a = await h.data<InsertedData>("insert_media", { assetId: "a1" });
    const b = await h.data<InsertedData>("insert_media", { assetId: "a2" });
    await h.data("delete", { elementIds: [a.elementId] });
    const t = await h.data<TimelineData>("get_timeline");
    expect(t.tracks[0]?.gaps).toEqual([{ start: 0, end: 10 }]);
    expect(b.start).toBe(10);
  });

  it("get_element returns full detail with keyframes, effects and masks", async () => {
    const h = setupAgent();
    const a = await h.data<InsertedData>("insert_media", { assetId: "a1" });
    await h.data("add_keyframe", { elementId: a.elementId, property: "opacity", time: 2, value: 0.5 });
    const fx = await h.data<{ effectId: string }>("add_effect", { elementId: a.elementId, effectType: "blur", params: { intensity: 20 } });
    const mask = await h.data<{ maskId: string }>("add_mask", { elementId: a.elementId, maskType: "ellipse" });
    const e = await h.data<ElementDetail>("get_element", { elementId: a.elementId });
    expect(e.params.opacity).toBe(1);
    expect(e.animations.opacity?.keyframes).toEqual([{ id: expect.any(String), time: 2, value: 0.5 }]);
    expect(e.effects).toEqual([{ id: fx.effectId, type: "blur", enabled: true, params: { intensity: 20 } }]);
    expect(e.masks[0]?.id).toBe(mask.maskId);
    expect(e.sourceDuration).toBe(10);
  });

  it("list_assets flags what is used", async () => {
    const h = setupAgent();
    await h.data("insert_media", { assetId: "a2" });
    const { assets } = await h.data<{ assets: Array<Record<string, unknown>> }>("list_assets");
    expect(assets).toHaveLength(ASSETS.length);
    expect(assets.find((a) => a.id === "a2")).toMatchObject({ type: "video", durationSeconds: 8, width: 1920, height: 1080, hasAudio: true, usedOnTimeline: true });
    expect(assets.find((a) => a.id === "a1")?.usedOnTimeline).toBe(false);
    expect(assets.find((a) => a.id === "photo")?.durationSeconds).toBeUndefined();
  });

  it("get_selection and get_playhead", async () => {
    const h = setupAgent();
    const a = await h.data<InsertedData>("insert_media", { assetId: "a1" });
    const sel = await h.data<{ elements: Array<{ elementId: string }> }>("get_selection");
    expect(sel.elements.map((e) => e.elementId)).toEqual([a.elementId]);
    await h.data("seek", { time: 2.5 });
    expect(await h.data("get_playhead")).toEqual({ seconds: 2.5, frame: 75, isPlaying: false, durationSeconds: 10 });
  });

  it("get_element on an unknown id lists real ids", async () => {
    const h = setupAgent();
    const a = await h.data<InsertedData>("insert_media", { assetId: "a1" });
    const f = await h.failure("get_element", { elementId: "nope" });
    expect(f.error).toContain('"nope"');
    expect(f.hint).toContain(a.elementId);
  });

  it("rejects bad input shape without throwing", async () => {
    const h = setupAgent();
    const f = await h.failure("get_element", { elementID: "x" });
    expect(f.hint).toContain("elementId");
    const unknown = await h.failure("get_timelin");
    expect(unknown.hint).toContain("get_timeline");
  });
});

describe("insert tools", () => {
  it("insert_media appends on main by default and snaps to the frame grid", async () => {
    const h = setupAgent();
    const a = await h.data<InsertedData>("insert_media", { assetId: "a1" });
    const b = await h.data<InsertedData>("insert_media", { assetId: "a2" });
    expect(a).toMatchObject({ start: 0, end: 10, trackCreated: false });
    expect(b).toMatchObject({ start: 10, end: 18, trackId: a.trackId });
    expect(tracksOf(h.editor).main.elements).toHaveLength(2);
    const c = await h.data<InsertedData>("insert_media", { assetId: "a3", start: 24.0123 });
    expect(c.start).toBe(24.0);
  });

  it("insert_media snaps start to the nearest frame at 30 fps", async () => {
    const h = setupAgent();
    await h.data("insert_media", { assetId: "a1" });
    const t = await h.data<InsertedData>("insert_text", { text: "x", start: 1.02, duration: 1 });
    expect(t.start).toBeCloseTo(1.033, 3);
    const t2 = await h.data<InsertedData>("insert_text", { text: "y", start: 1.012, duration: 1, newTrack: true });
    expect(t2.start).toBeCloseTo(1.0, 3);
  });

  it("insert_media overlapping main creates an overlay track; explicit trackId fails", async () => {
    const h = setupAgent();
    const a = await h.data<InsertedData>("insert_media", { assetId: "a1" });
    const b = await h.data<InsertedData>("insert_media", { assetId: "a2", start: 4 });
    expect(b.trackCreated).toBe(true);
    expect(b.trackId).not.toBe(a.trackId);
    expect(tracksOf(h.editor).overlay).toHaveLength(1);
    const f = await h.failure("insert_media", { assetId: "a3", start: 2, trackId: a.trackId });
    expect(f.error).toContain("occupied");
    expect(f.hint).toContain("newTrack");
  });

  it("insert_media places audio on an audio track, images get a duration", async () => {
    const h = setupAgent();
    const m = await h.data<InsertedData>("insert_media", { assetId: "music" });
    expect(tracksOf(h.editor).audio[0]?.id).toBe(m.trackId);
    const img = await h.data<InsertedData>("insert_media", { assetId: "photo", duration: 3 });
    expect(img.duration).toBe(3);
  });

  it("insert_media failure modes: unknown asset, wrong track kind, duration on video", async () => {
    const h = setupAgent();
    const a = await h.data<InsertedData>("insert_media", { assetId: "a1" });
    const unknown = await h.failure("insert_media", { assetId: "ghost" });
    expect(unknown.hint).toContain("list_assets");
    const wrongTrack = await h.failure("insert_media", { assetId: "music", trackId: a.trackId });
    expect(wrongTrack.error).toContain("cannot hold");
    const duration = await h.failure("insert_media", { assetId: "a2", duration: 2 });
    expect(duration.error).toContain("images");
    const both = await h.failure("insert_media", { assetId: "a2", trackId: a.trackId, newTrack: true });
    expect(both.error).toContain("either");
  });

  it("insert_text applies style and reports its placement", async () => {
    const h = setupAgent();
    const t = await h.data<InsertedData>("insert_text", {
      text: "Title", start: 1, duration: 2, style: { fontSize: 20, color: "#ff0000", fontWeight: "bold", backgroundColor: "#000000" },
    });
    expect(t).toMatchObject({ start: 1, end: 3, duration: 2 });
    const e = await h.data<ElementDetail>("get_element", { elementId: t.elementId });
    expect(e.params).toMatchObject({ content: "Title", fontSize: 20, color: "#ff0000", fontWeight: "bold", "background.enabled": true, "background.color": "#000000" });
  });

  it("insert_text failure modes: bad style key, empty text, bad color", async () => {
    const h = setupAgent();
    const key = await h.failure("insert_text", { text: "x", style: { colour: "#fff" } });
    expect(key.hint).toContain("color");
    const empty = await h.failure("insert_text", { text: "" });
    expect(empty.error).toContain("empty");
    const color = await h.failure("insert_text", { text: "x", style: { color: "red" } });
    expect(color.error).toContain("#rrggbb");
  });

  it("insert_graphic and insert_effect_layer", async () => {
    const h = setupAgent();
    await h.data("insert_media", { assetId: "a1" });
    const g = await h.data<InsertedData>("insert_graphic", { shape: "star", start: 1, duration: 2, params: { points: 7, fill: "#00ff00", "transform.scaleX": 2 } });
    const ge = await h.data<ElementDetail>("get_element", { elementId: g.elementId });
    expect(ge.params).toMatchObject({ points: 7, fill: "#00ff00", "transform.scaleX": 2 });
    expect(ge.shape).toBe("star");
    const fx = await h.data<InsertedData>("insert_effect_layer", { effectType: "blur", start: 0, duration: 4, params: { intensity: 40 } });
    expect(fx.duration).toBe(4);
    const fe = await h.data<ElementDetail>("get_element", { elementId: fx.elementId });
    expect(fe.params).toEqual({ intensity: 40 });
  });

  it("insert_graphic / insert_effect_layer failures list valid options", async () => {
    const h = setupAgent();
    const shape = await h.failure("insert_graphic", { shape: "hexagon" });
    expect(shape.error).toContain("shape");
    const param = await h.failure("insert_graphic", { shape: "star", params: { point: 3 } });
    expect(param.hint).toContain('Did you mean "points"');
    const range = await h.failure("insert_graphic", { shape: "star", params: { points: 99 } });
    expect(range.error).toContain("maximum 12");
    const effect = await h.failure("insert_effect_layer", { effectType: "sparkle" });
    expect(effect.hint).toContain("blur");
  });
});
