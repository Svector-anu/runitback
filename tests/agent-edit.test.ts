import { describe, expect, it } from "vitest";
import { allElements } from "#/engine/timeline";
import { setupAgent, tracksOf, type InsertedData } from "./agent-harness";

interface SplitData { at: number; pieces: Array<{ originalId: string; left?: string; right?: string }>; skipped: string[] }

async function threeClips() {
  const h = setupAgent();
  const a = await h.data<InsertedData>("insert_media", { assetId: "a1" });
  const b = await h.data<InsertedData>("insert_media", { assetId: "a2" });
  const c = await h.data<InsertedData>("insert_media", { assetId: "a3" });
  return { h, a, b, c };
}

describe("split", () => {
  it("cuts every clip under the time, keeps the original id on the left", async () => {
    const { h, a } = await threeClips();
    const s = await h.data<SplitData>("split", { at: 4 });
    expect(s.pieces).toHaveLength(1);
    expect(s.pieces[0]).toMatchObject({ originalId: a.elementId, left: a.elementId });
    const [left, right] = tracksOf(h.editor).main.elements;
    expect([left?.startTime, left?.duration]).toEqual([0, 4 * 120000]);
    expect(right?.id).toBe(s.pieces[0]?.right);
    expect(right?.trimStart).toBe(4 * 120000);
  });

  it("targets given ids only, reports clips it skipped and honours retain", async () => {
    const { h, b, c } = await threeClips();
    const s = await h.data<SplitData>("split", { at: 12, elementIds: [b.elementId, c.elementId], retain: "right" });
    expect(s.skipped).toEqual([c.elementId]);
    expect(s.pieces[0]?.left).toBeUndefined();
    expect(tracksOf(h.editor).main.elements.map((e) => e.startTime / 120000)).toEqual([0, 12, 18]);
  });

  it("defaults to the playhead and snaps `at` to a frame", async () => {
    const { h } = await threeClips();
    await h.data("seek", { time: 5 });
    expect((await h.data<SplitData>("split")).at).toBe(5);
    expect((await h.data<SplitData>("split", { at: 12.013 })).at).toBe(12);
  });

  it("fails when no clip crosses the time or the id is a miss", async () => {
    const { h, a } = await threeClips();
    const edge = await h.failure("split", { at: 10 });
    expect(edge.hint).toContain("strictly inside");
    const onlyA = await h.failure("split", { at: 15, elementIds: [a.elementId] });
    expect(onlyA.error).toContain("nothing to split");
    await h.failure("split", { at: 3, elementIds: ["zzz"] });
    await h.failure("split", { at: 3, retain: "middle" });
  });
});

describe("trim", () => {
  it("moves the left edge: trimStart grows, clip keeps its right edge", async () => {
    const { h, b } = await threeClips();
    const t = await h.data<Record<string, number | boolean>>("trim", { elementId: b.elementId, start: 12 });
    expect(t).toMatchObject({ start: 12, end: 18, trimStart: 2, clamped: false });
  });

  it("moves the right edge", async () => {
    const { h, c } = await threeClips();
    const t = await h.data<Record<string, number | boolean>>("trim", { elementId: c.elementId, end: 22 });
    expect(t).toMatchObject({ start: 18, end: 22, duration: 4, clamped: false });
  });

  it("clamps to the source length and says so", async () => {
    const { h, c } = await threeClips();
    const t = await h.data<Record<string, number | boolean>>("trim", { elementId: c.elementId, end: 40 });
    expect(t).toMatchObject({ end: 24, clamped: true });
  });

  it("rejects empty and inverted trims", async () => {
    const { h, b } = await threeClips();
    expect((await h.failure("trim", { elementId: b.elementId })).error).toContain("Nothing to trim");
    const inverted = await h.failure("trim", { elementId: b.elementId, start: 17, end: 12 });
    expect(inverted.error).toContain("empty clip");
    expect(inverted.hint).toContain("10s-18s");
  });
});

describe("move", () => {
  it("shifts by delta and places by start with offsets kept", async () => {
    const { h, c } = await threeClips();
    const text1 = await h.data<InsertedData>("insert_text", { text: "a", start: 1, duration: 1 });
    const text2 = await h.data<InsertedData>("insert_text", { text: "b", start: 3, duration: 1, trackId: text1.trackId });
    const m = await h.data<{ moved: Array<{ elementId: string; start: number }> }>("move", { elementIds: [text1.elementId, text2.elementId], delta: 2 });
    expect(m.moved.map((x) => x.start)).toEqual([3, 5]);
    const n = await h.data<{ moved: Array<{ elementId: string; start: number }> }>("move", { elementIds: [text2.elementId, text1.elementId], start: 10 });
    expect(n.moved.find((x) => x.elementId === text1.elementId)?.start).toBe(10);
    expect(n.moved.find((x) => x.elementId === text2.elementId)?.start).toBe(12);
    expect(c.start).toBe(18);
  });

  it("moves to another track of the same kind", async () => {
    const { h } = await threeClips();
    const t1 = await h.data<InsertedData>("insert_text", { text: "a", start: 1, duration: 1 });
    const t2 = await h.data<InsertedData>("insert_text", { text: "b", start: 1, duration: 1, newTrack: true });
    const moved = await h.data<{ moved: Array<{ trackId: string }> }>("move", { elementIds: [t2.elementId], trackId: t1.trackId, start: 5 });
    expect(moved.moved[0]?.trackId).toBe(t1.trackId);
  });

  it("fails on overlap, negative start, wrong track kind and conflicting args", async () => {
    const { h, a, c } = await threeClips();
    const text = await h.data<InsertedData>("insert_text", { text: "a", start: 1, duration: 1 });
    const overlap = await h.failure("move", { elementIds: [c.elementId], delta: -3 });
    expect(overlap.error).toContain("overlap");
    expect(overlap.hint).toContain("gaps");
    expect((await h.failure("move", { elementIds: [text.elementId], delta: -5 })).error).toContain("before the timeline start");
    expect((await h.failure("move", { elementIds: [text.elementId], trackId: a.trackId })).error).toContain("cannot go on");
    await h.failure("move", { elementIds: [a.elementId], delta: 1, start: 2 });
    await h.failure("move", { elementIds: [a.elementId] });
    expect(allElements(tracksOf(h.editor)).find((l) => l.element.id === c.elementId)?.element.startTime).toBe(18 * 120000);
  });
});

describe("delete and duplicate", () => {
  it("delete leaves a gap by default and closes it with ripple", async () => {
    const { h, a, b, c } = await threeClips();
    await h.data("delete", { elementIds: [b.elementId] });
    expect(tracksOf(h.editor).main.elements.map((e) => e.id)).toEqual([a.elementId, c.elementId]);
    expect(tracksOf(h.editor).main.elements[1]?.startTime).toBe(18 * 120000);
    const r = await h.data<{ durationSeconds: number }>("delete", { elementIds: [a.elementId], ripple: true });
    expect(tracksOf(h.editor).main.elements[0]?.startTime).toBe(8 * 120000);
    expect(r.durationSeconds).toBe(14);
    expect(h.editor.getState().rippleEnabled).toBe(false);
  });

  it("delete across tracks removes emptied overlay tracks; unknown id changes nothing", async () => {
    const { h, a } = await threeClips();
    const t = await h.data<InsertedData>("insert_text", { text: "a" });
    await h.data("delete", { elementIds: [t.elementId, a.elementId] });
    expect(tracksOf(h.editor).overlay).toHaveLength(0);
    const revision = h.editor.getState().revision;
    await h.failure("delete", { elementIds: [a.elementId] });
    await h.failure("delete", { elementIds: [] });
    expect(h.editor.getState().revision).toBe(revision);
  });

  it("duplicate places copies on a new track and returns their ids", async () => {
    const { h, b } = await threeClips();
    const d = await h.data<{ copies: Array<{ elementId: string; trackId: string; start: number }> }>("duplicate", { elementIds: [b.elementId] });
    expect(d.copies).toHaveLength(1);
    expect(d.copies[0]?.elementId).not.toBe(b.elementId);
    expect(d.copies[0]?.start).toBe(10);
    expect(tracksOf(h.editor).overlay).toHaveLength(1);
    await h.failure("duplicate", { elementIds: ["nope"] });
    await h.failure("duplicate", { elementIds: [] });
  });
});

describe("set_speed", () => {
  it("re-derives duration from the source", async () => {
    const h = setupAgent();
    const a = await h.data<InsertedData>("insert_media", { assetId: "a1" });
    const s = await h.data<Record<string, number | boolean>>("set_speed", { elementId: a.elementId, speed: 2 });
    expect(s).toMatchObject({ speed: 2, duration: 5, end: 5, previousDuration: 10, limitedByNeighbour: false });
    const back = await h.data<Record<string, number>>("set_speed", { elementId: a.elementId, speed: 1 });
    expect(back.duration).toBe(10);
  });

  it("slowing down stops at the next clip", async () => {
    const { h, a } = await threeClips();
    const s = await h.data<Record<string, number | boolean>>("set_speed", { elementId: a.elementId, speed: 0.5 });
    expect(s).toMatchObject({ limitedByNeighbour: true, end: 10 });
  });

  it("rejects text clips and out-of-range speeds", async () => {
    const h = setupAgent();
    const t = await h.data<InsertedData>("insert_text", { text: "x" });
    expect((await h.failure("set_speed", { elementId: t.elementId, speed: 2 })).error).toContain("text");
    const a = await h.data<InsertedData>("insert_media", { assetId: "a1" });
    expect((await h.failure("set_speed", { elementId: a.elementId, speed: 50 })).error).toContain("<=");
  });
});
