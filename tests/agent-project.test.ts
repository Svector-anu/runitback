import { describe, expect, it } from "vitest";
import { allElements } from "#/engine/timeline";
import { setupAgent, tracksOf, type InsertedData } from "./agent-harness";

const SRT = `1
00:00:01,000 --> 00:00:03,000
Hello world

2
00:00:02,500 --> 00:00:05,000
Overlapping second line that is long enough to need wrapping across several lines of the frame

3
00:00:06,000 --> 00:00:07,000
Third
`;

describe("set_track / delete_track", () => {
  it("sets absolute mute and hidden flags", async () => {
    const h = setupAgent();
    const a = await h.data<InsertedData>("insert_media", { assetId: "a1" });
    const music = await h.data<InsertedData>("insert_media", { assetId: "music" });
    expect(await h.data("set_track", { trackId: a.trackId, muted: true, hidden: true })).toEqual({ trackId: a.trackId, muted: true, hidden: true });
    await h.data("set_track", { trackId: a.trackId, muted: true });
    expect(tracksOf(h.editor).main.muted).toBe(true);
    await h.data("set_track", { trackId: music.trackId, muted: true });
    expect(tracksOf(h.editor).audio[0]?.muted).toBe(true);
  });

  it("set_track failures: no audio on text tracks, no hiding audio, unknown track", async () => {
    const h = setupAgent();
    const t = await h.data<InsertedData>("insert_text", { text: "x" });
    const music = await h.data<InsertedData>("insert_media", { assetId: "music" });
    expect((await h.failure("set_track", { trackId: t.trackId, muted: true })).error).toContain("no audio");
    expect((await h.failure("set_track", { trackId: music.trackId, hidden: true })).error).toContain("cannot be hidden");
    expect((await h.failure("set_track", { trackId: "ghost", hidden: true })).hint).toContain("get_timeline");
    await h.failure("set_track", { trackId: t.trackId });
  });

  it("delete_track removes the track and its clips; main is protected", async () => {
    const h = setupAgent();
    const a = await h.data<InsertedData>("insert_media", { assetId: "a1" });
    const t = await h.data<InsertedData>("insert_text", { text: "x" });
    const r = await h.data<{ removedElementIds: string[] }>("delete_track", { trackId: t.trackId });
    expect(r.removedElementIds).toEqual([t.elementId]);
    expect(tracksOf(h.editor).overlay).toHaveLength(0);
    expect((await h.failure("delete_track", { trackId: a.trackId })).error).toContain("main track");
    await h.failure("delete_track", { trackId: "ghost" });
  });
});

describe("set_project", () => {
  it("changes canvas by preset or size, fps and background", async () => {
    const h = setupAgent();
    expect(await h.data("set_project", { canvasPreset: "9:16" })).toMatchObject({ canvas: { width: 1080, height: 1920 } });
    expect(h.editor.getState().doc.settings.canvasSizeMode).toBe("preset");
    await h.data("set_project", { width: 1280, height: 720, fps: 24, backgroundColor: "#102030" });
    const s = h.editor.getState().doc.settings;
    expect(s.canvasSize).toEqual({ width: 1280, height: 720 });
    expect(s.canvasSizeMode).toBe("custom");
    expect(s.fps).toEqual({ numerator: 24, denominator: 1 });
    expect(s.background).toEqual({ type: "color", color: "#102030" });
    await h.data("set_project", { backgroundBlur: 30 });
    expect(h.editor.getState().doc.settings.background).toEqual({ type: "blur", blurIntensity: 30 });
    expect((await h.data<{ fps: number }>("set_project", { fps: 29.97 })).fps).toBe(29.97);
  });

  it("failures: nothing to change, half a size, odd size, bad color, conflicting args", async () => {
    const h = setupAgent();
    expect((await h.failure("set_project", {})).error).toContain("Nothing");
    expect((await h.failure("set_project", { width: 1280 })).error).toContain("together");
    expect((await h.failure("set_project", { width: 1281, height: 720 })).error).toContain("even");
    expect((await h.failure("set_project", { backgroundColor: "blue" })).hint).toContain("#rrggbb");
    await h.failure("set_project", { canvasPreset: "1:1", width: 100, height: 100 });
    await h.failure("set_project", { canvasPreset: "21:9" });
    expect(h.editor.getState().doc.settings.canvasSize).toEqual({ width: 1920, height: 1080 });
  });

  it("frame snapping follows the new fps", async () => {
    const h = setupAgent();
    await h.data("set_project", { fps: 24 });
    await h.data("insert_media", { assetId: "a1" });
    const t = await h.data<InsertedData>("insert_text", { text: "x", start: 1.03, duration: 1 });
    expect(t.start).toBeCloseTo(1.0417, 3);
  });
});

describe("bookmarks and captions", () => {
  it("add_bookmark snaps, then updates in place", async () => {
    const h = setupAgent();
    await h.data("add_bookmark", { time: 2.01, note: "intro" });
    await h.data("add_bookmark", { time: 2.01, note: "hook", color: "#ff0000" });
    const marks = h.editor.getState().doc.scenes[0]?.bookmarks;
    expect(marks).toHaveLength(1);
    expect(marks?.[0]).toMatchObject({ time: 2 * 120000, note: "hook", color: "#ff0000" });
    expect((await h.failure("add_bookmark", { time: -1 })).error).toContain(">=");
  });

  it("import_captions builds a text track, shortening overlaps", async () => {
    const h = setupAgent();
    await h.data("insert_media", { assetId: "a1" });
    const r = await h.data<{ trackId: string; count: number; shortenedOverlaps: number }>("import_captions", { srt: SRT });
    expect(r).toMatchObject({ count: 3, shortenedOverlaps: 1 });
    const cues = allElements(tracksOf(h.editor)).filter((l) => l.track.id === r.trackId).map((l) => l.element);
    expect(cues.map((c) => [c.startTime / 120000, (c.startTime + c.duration) / 120000])).toEqual([[1, 2.5], [2.5, 5], [6, 7]]);
    expect(tracksOf(h.editor).overlay[0]?.id).toBe(r.trackId);
    expect(String(cues[1]?.params.content)).toContain("\n");
    h.editor.undo();
    expect(tracksOf(h.editor).overlay).toHaveLength(0);
  });

  it("import_captions applies an offset and reads ass", async () => {
    const h = setupAgent();
    const ass = `[Script Info]\nPlayResY: 1080\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Default,Arial,48,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,0,2,10,10,10,1\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,Hi there\n`;
    const r = await h.data<{ count: number; start: number }>("import_captions", { ass, offset: 1 });
    expect(r).toMatchObject({ count: 1, start: 2 });
  });

  it("import_captions failures: both formats, neither, garbage, all before zero", async () => {
    const h = setupAgent();
    expect((await h.failure("import_captions", { srt: SRT, ass: "x" })).error).toContain("exactly one");
    await h.failure("import_captions", {});
    expect((await h.failure("import_captions", { srt: "not subtitles" })).error).toContain("No valid");
    expect((await h.failure("import_captions", { srt: SRT, offset: -60 })).error).toContain("before 0s");
  });
});

describe("seek, select, undo, redo", () => {
  it("seek snaps and clamps to the duration", async () => {
    const h = setupAgent();
    await h.data("insert_media", { assetId: "a1" });
    expect(await h.data("seek", { time: 3.01 })).toMatchObject({ seconds: 3, clamped: false });
    expect(await h.data("seek", { time: 99 })).toMatchObject({ seconds: 10, clamped: true });
    await h.failure("seek", { time: "now" });
  });

  it("select sets and clears the selection", async () => {
    const h = setupAgent();
    const a = await h.data<InsertedData>("insert_media", { assetId: "a1" });
    const b = await h.data<InsertedData>("insert_media", { assetId: "a2" });
    await h.data("select", { elementIds: [a.elementId, b.elementId] });
    expect(h.editor.selectionRefs().map((r) => r.elementId)).toEqual([a.elementId, b.elementId]);
    await h.data("select", { elementIds: [] });
    expect(h.editor.selectionRefs()).toEqual([]);
    expect((await h.failure("select", { elementIds: ["ghost"] })).hint).toContain("get_timeline");
  });

  it("undo and redo walk the history", async () => {
    const h = setupAgent();
    await h.data("insert_media", { assetId: "a1" });
    await h.data("insert_media", { assetId: "a2" });
    expect(await h.data("undo")).toMatchObject({ steps: 1, canRedo: true });
    expect(tracksOf(h.editor).main.elements).toHaveLength(1);
    expect(await h.data("undo", { steps: 5 })).toMatchObject({ steps: 1, canUndo: false });
    expect(tracksOf(h.editor).main.elements).toHaveLength(0);
    expect((await h.failure("undo")).error).toContain("Nothing to undo");
    await h.data("redo", { steps: 2 });
    expect(tracksOf(h.editor).main.elements).toHaveLength(2);
    expect((await h.failure("redo")).error).toContain("Nothing to redo");
  });

  it("add_mask with params is a single undo step", async () => {
    const h = setupAgent();
    const a = await h.data<InsertedData>("insert_media", { assetId: "a1" });
    await h.data("add_mask", { elementId: a.elementId, maskType: "ellipse", params: { feather: 5 } });
    h.editor.undo();
    expect(h.editor.getState().canUndo).toBe(true);
    expect(tracksOf(h.editor).main.elements).toHaveLength(1);
    expect((tracksOf(h.editor).main.elements[0] as { masks?: unknown[] }).masks ?? []).toEqual([]);
  });
});
