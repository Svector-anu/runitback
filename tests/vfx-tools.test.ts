import { describe, expect, it } from "vitest";
import type { VideoElement } from "#/engine/model";
import { allElements, sceneViolations } from "#/engine/timeline";
import { currentScene } from "#/engine/commands";
import { setupAgent, tracksOf, type InsertedData } from "./agent-harness";

const find = (h: ReturnType<typeof setupAgent>, id: string) => {
  const found = allElements(tracksOf(h.editor)).find((l) => l.element.id === id);
  if (!found) throw new Error(`missing ${id}`);
  return found.element;
};
const expectHealthy = (h: ReturnType<typeof setupAgent>): void => {
  expect(sceneViolations(currentScene(h.editor.getState().doc))).toEqual([]);
};

describe("set_speed_ramp", () => {
  it("applies a preset: the clip gets longer where it slows down, in one undo step", async () => {
    const h = setupAgent();
    const clip = await h.data<InsertedData>("insert_media", { assetId: "a1" });
    const before = find(h, clip.elementId).duration;
    const result = await h.data<{ duration: number; previousDuration: number; ramp: string; limitedByNeighbour: boolean; shape: Array<{ position: number; speed: number }> }>(
      "set_speed_ramp", { elementId: clip.elementId, preset: "hero" },
    );
    expect(result.ramp).toBe("hero");
    expect(result.duration).toBeGreaterThan(result.previousDuration);
    expect(result.limitedByNeighbour).toBe(false);
    expect(result.shape.some((p) => p.speed === 0.25)).toBe(true);
    expectHealthy(h);
    const ramped = find(h, clip.elementId) as VideoElement;
    expect(ramped.retime?.curve?.points.length).toBe(5);
    h.editor.undo();
    expect(find(h, clip.elementId).duration).toBe(before);
    expect((find(h, clip.elementId) as VideoElement).retime).toBeUndefined();
  });

  it("takes custom points relative to the visible source and survives a trim", async () => {
    const h = setupAgent();
    const clip = await h.data<InsertedData>("insert_media", { assetId: "a1" });
    await h.data("trim", { elementId: clip.elementId, start: 2, end: 8 });
    await h.data("set_speed_ramp", { elementId: clip.elementId, points: [{ position: 0, speed: 2 }, { position: 0.5, speed: 0.5 }, { position: 1, speed: 2 }] });
    const el = find(h, clip.elementId) as VideoElement;
    const at = el.retime?.curve?.points.map((p) => p.at) ?? [];
    expect(at[0]).toBe(el.trimStart);
    expect(at).toHaveLength(3);
    expectHealthy(h);
  });

  it("clear returns to constant 1x; set_speed replaces a ramp", async () => {
    const h = setupAgent();
    const clip = await h.data<InsertedData>("insert_media", { assetId: "a1" });
    await h.data("set_speed_ramp", { elementId: clip.elementId, preset: "montage" });
    await h.data("set_speed_ramp", { elementId: clip.elementId, clear: true });
    expect((find(h, clip.elementId) as VideoElement).retime).toBeUndefined();
    expect(find(h, clip.elementId).duration).toBe(clip.duration * 120_000);
    await h.data("set_speed_ramp", { elementId: clip.elementId, preset: "bullet" });
    await h.data("set_speed", { elementId: clip.elementId, speed: 2 });
    expect((find(h, clip.elementId) as VideoElement).retime).toMatchObject({ rate: 2 });
    expect((find(h, clip.elementId) as VideoElement).retime?.curve).toBeUndefined();
    expectHealthy(h);
  });

  it("stops at the next clip instead of overlapping it", async () => {
    const h = setupAgent();
    const a = await h.data<InsertedData>("insert_media", { assetId: "a1" });
    await h.data<InsertedData>("insert_media", { assetId: "a2", start: a.end });
    const result = await h.data<{ limitedByNeighbour: boolean }>("set_speed_ramp", { elementId: a.elementId, preset: "hero" });
    expect(result.limitedByNeighbour).toBe(true);
    expectHealthy(h);
  });

  it("works on audio clips and refuses text, bad points, and ambiguous calls", async () => {
    const h = setupAgent();
    const music = await h.data<InsertedData>("insert_media", { assetId: "music" });
    await h.data("set_speed_ramp", { elementId: music.elementId, preset: "jump-cut-ease", maintainPitch: true });
    expect((find(h, music.elementId) as { retime?: { maintainPitch?: boolean } }).retime?.maintainPitch).toBe(true);
    const text = await h.data<InsertedData>("insert_text", { text: "hi" });
    await h.failure("set_speed_ramp", { elementId: text.elementId, preset: "hero" });
    const clip = await h.data<InsertedData>("insert_media", { assetId: "a1", start: 40 });
    expect((await h.failure("set_speed_ramp", { elementId: clip.elementId, points: [{ position: 0, speed: 1 }] })).error).toMatch(/2 to 6/);
    expect((await h.failure("set_speed_ramp", { elementId: clip.elementId, points: [{ position: 0.5, speed: 1 }, { position: 0.2, speed: 1 }] })).error).toMatch(/increasing/);
    expect((await h.failure("set_speed_ramp", { elementId: clip.elementId, points: [{ position: 0, speed: 9 }, { position: 1, speed: 1 }] })).error).toMatch(/<= 5/);
    await h.failure("set_speed_ramp", { elementId: clip.elementId });
    await h.failure("set_speed_ramp", { elementId: clip.elementId, preset: "hero", clear: true });
    await h.failure("set_speed_ramp", { elementId: clip.elementId, preset: "nope" });
    expectHealthy(h);
  });

  it("split keeps the ramp on the same footage", async () => {
    const h = setupAgent();
    const clip = await h.data<InsertedData>("insert_media", { assetId: "a1" });
    await h.data("set_speed_ramp", { elementId: clip.elementId, preset: "hero" });
    const ramped = find(h, clip.elementId);
    await h.data("split", { elementIds: [clip.elementId], at: (ramped.duration / 120_000) * 0.6 });
    const clips = allElements(tracksOf(h.editor)).map((l) => l.element as VideoElement).filter((e) => e.type === "video");
    expect(clips).toHaveLength(2);
    expect(clips[0]?.retime?.curve).toEqual(clips[1]?.retime?.curve);
    expectHealthy(h);
  });
});

describe("set_chroma_key", () => {
  it("adds one chroma-key effect and edits it on later calls instead of stacking", async () => {
    const h = setupAgent();
    const clip = await h.data<InsertedData>("insert_media", { assetId: "a1" });
    await h.data("set_chroma_key", { elementIds: [clip.elementId] });
    await h.data("set_chroma_key", { elementIds: [clip.elementId], similarity: 55, keyColor: "#00cc44" });
    const effects = (find(h, clip.elementId) as VideoElement).effects ?? [];
    expect(effects).toHaveLength(1);
    expect(effects[0]).toMatchObject({ type: "chroma-key", enabled: true, params: { similarity: 55, keyColor: "#00cc44" } });
    h.editor.undo();
    expect((find(h, clip.elementId) as VideoElement).effects?.[0]?.params.similarity).toBe(30);
  });

  it("removes it, keys several clips at once, and warns when a clip is on the main track", async () => {
    const h = setupAgent();
    const a = await h.data<InsertedData>("insert_media", { assetId: "a1" });
    const b = await h.data<InsertedData>("insert_media", { assetId: "a2", start: 1 });
    const result = await h.call("set_chroma_key", { elementIds: [a.elementId, b.elementId], smoothness: 20 });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.summary).toMatch(/main track/);
    expect(((find(h, b.elementId) as VideoElement).effects ?? [])).toHaveLength(1);
    await h.data("set_chroma_key", { elementIds: [a.elementId, b.elementId], remove: true });
    expect(((find(h, a.elementId) as VideoElement).effects ?? [])).toHaveLength(0);
    await h.failure("set_chroma_key", { elementIds: [a.elementId], remove: true });
  });

  it("refuses text and graphics, empty lists, bad colours and out-of-range values", async () => {
    const h = setupAgent();
    const text = await h.data<InsertedData>("insert_text", { text: "x" });
    const clip = await h.data<InsertedData>("insert_media", { assetId: "a1" });
    await h.failure("set_chroma_key", { elementIds: [text.elementId] });
    await h.failure("set_chroma_key", { elementIds: [] });
    await h.failure("set_chroma_key", { elementIds: [clip.elementId], keyColor: "green" });
    await h.failure("set_chroma_key", { elementIds: [clip.elementId], similarity: 101 });
    await h.failure("set_chroma_key", { elementIds: [clip.elementId], spill: -1 });
  });
});
