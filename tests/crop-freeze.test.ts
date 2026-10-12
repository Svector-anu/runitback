import { describe, expect, it } from "vitest";
import { freezeFrameCommand, insertElement, setElementParams, splitCommand } from "#/engine/commands";
import { buildFramePlan, resolveCrop, type MediaLayer } from "#/engine/render";
import { allElements, assertDocumentInvariants } from "#/engine/timeline";
import type { Editor } from "#/engine/editor";
import type { ImageElement } from "#/engine/model";
import { deserializeProject, serializeProject } from "#/engine/persistence";
import { setupAgent } from "./agent-harness";
import { makeEditor, sec, tracksWith, video, videoAsset } from "./helpers";

const canvas = { width: 1920, height: 1080 };
const bg = { type: "color", color: "#000000" } as const;

describe("crop", () => {
  it("clamps each edge and keeps something visible", () => {
    expect(resolveCrop({})).toBeNull();
    expect(resolveCrop({ "crop.left": 0.2, "crop.top": 0.1 })).toEqual({ left: 0.2, top: 0.1, right: 0, bottom: 0 });
    const heavy = resolveCrop({ "crop.left": 0.9, "crop.right": 0.9 });
    expect(heavy!.left + heavy!.right).toBeCloseTo(0.95, 6);
    expect(resolveCrop({ "crop.left": -1, "crop.top": 5 })).toEqual({ left: 0, top: 0.95, right: 0, bottom: 0 });
  });
  it("reaches the frame plan with animated values and leaves the transform alone", () => {
    const el = video("a", 0, 4, { params: { ...video("a", 0, 4).params, "crop.left": 0.25, "crop.bottom": 0.5 } });
    const layer = buildFramePlan({ tracks: tracksWith({ main: [el] }), canvas, background: bg, assets: [videoAsset("asset-a", 4)], time: sec(1) }).items[0] as MediaLayer;
    expect(layer.crop).toEqual({ left: 0.25, top: 0, right: 0, bottom: 0.5 });
    expect(layer.transform).toMatchObject({ width: 1920, height: 1080, centerX: 960, centerY: 540 });
  });
  it("new clips carry zeroed crop params; the inspector command clamps out-of-range values", () => {
    const { editor } = makeEditor();
    editor.execute(insertElement({ element: video("a", 0, 4), placement: { mode: "explicit", trackId: editor.tracks().main.id } }));
    const ref = { trackId: editor.tracks().main.id, elementId: "a" };
    expect(editor.tracks().main.elements[0]?.params["crop.left"]).toBe(0);
    editor.execute(setElementParams({ refs: [ref], params: { "crop.left": 4 } }));
    expect(editor.tracks().main.elements[0]?.params["crop.left"]).toBe(0.95);
  });
  it("set_crop crops several clips in one undo step, validates and rejects text", async () => {
    const h = setupAgent();
    await h.data("insert_media", { assetId: "a1", start: 0 });
    await h.data("insert_text", { text: "x", start: 0, duration: 2 });
    const tl = await h.data<{ tracks: Array<{ elements: Array<{ id: string; type: string }> }> }>("get_timeline");
    const els = tl.tracks.flatMap((t) => t.elements);
    const videoId = els.find((e) => e.type === "video")!.id;
    const textId = els.find((e) => e.type === "text")!.id;
    await h.data("set_crop", { elementIds: [videoId], left: 0.1, top: 0.2 });
    await h.data("set_crop", { elementIds: [videoId], right: 0.3 });
    const params = () => allElements(h.editor.tracks()).find((l) => l.element.id === videoId)!.element.params;
    expect(params()).toMatchObject({ "crop.left": 0.1, "crop.top": 0.2, "crop.right": 0.3 });
    h.editor.undo();
    expect(params()["crop.right"]).toBe(0);
    await h.data("set_crop", { elementIds: [videoId], reset: true });
    expect(params()["crop.left"]).toBe(0);
    expect((await h.failure("set_crop", { elementIds: [videoId], left: 0.6, right: 0.6 })).error).toContain("remove");
    expect((await h.failure("set_crop", { elementIds: [textId], left: 0.1 })).error).toContain("text");
    expect((await h.failure("set_crop", { elementIds: [videoId] })).error).toContain("Nothing");
  });
});

describe("freeze frame", () => {
  function twoClips(): { editor: Editor; main: string } {
    const { editor } = makeEditor();
    const main = editor.tracks().main.id;
    editor.execute(insertElement({ element: video("a", 0, 6), placement: { mode: "explicit", trackId: main } }));
    editor.execute(insertElement({ element: video("b", 6, 4), placement: { mode: "explicit", trackId: main } }));
    return { editor, main };
  }
  const layout = (editor: Editor) => editor.tracks().main.elements.map((e) => [e.id, e.type, e.startTime / sec(1), e.duration / sec(1)] as const).sort((x, y) => x[2] - y[2]);

  it("cuts the clip at the playhead, inserts the still and ripples the track", () => {
    const { editor, main } = twoClips();
    editor.execute(freezeFrameCommand({ ref: { trackId: main, elementId: "a" }, at: sec(2), duration: sec(3), elementId: "freeze" }));
    expect(layout(editor).map((l) => l.slice(1))).toEqual([["video", 0, 2], ["image", 2, 3], ["video", 5, 4], ["video", 9, 4]]);
    const freeze = editor.tracks().main.elements.find((e) => e.id === "freeze") as ImageElement;
    expect(freeze.freezeAt).toBe(sec(2));
    expect(freeze.mediaId).toBe("asset-a");
    assertDocumentInvariants(editor.getState().doc);
    editor.undo();
    expect(layout(editor).map((l) => l.slice(1))).toEqual([["video", 0, 6], ["video", 6, 4]]);
  });
  it("honours trim and speed when picking the source frame", () => {
    const { editor } = makeEditor();
    const main = editor.tracks().main.id;
    editor.execute(insertElement({ element: video("a", 0, 4, { trimStart: sec(2), retime: { rate: 2 }, duration: sec(4), sourceDuration: sec(12), trimEnd: sec(2) }), placement: { mode: "explicit", trackId: main } }));
    editor.execute(freezeFrameCommand({ ref: { trackId: main, elementId: "a" }, at: sec(1), duration: sec(1), elementId: "f" }));
    expect((editor.tracks().main.elements.find((e) => e.id === "f") as ImageElement).freezeAt).toBe(sec(4));
  });
  it("at the clip start the still goes first and the clip moves later whole", () => {
    const { editor, main } = twoClips();
    editor.execute(freezeFrameCommand({ ref: { trackId: main, elementId: "b" }, at: sec(6), duration: sec(1), elementId: "f" }));
    expect(layout(editor).map((l) => l.slice(1))).toEqual([["video", 0, 6], ["image", 6, 1], ["video", 7, 4]]);
  });
  it("rejects a time outside the clip or a non-video clip and changes nothing", () => {
    const { editor, main } = twoClips();
    const before = JSON.stringify(editor.tracks());
    expect(() => editor.execute(freezeFrameCommand({ ref: { trackId: main, elementId: "a" }, at: sec(6), duration: sec(1) }))).toThrow(/inside the clip/);
    expect(JSON.stringify(editor.tracks())).toBe(before);
  });
  it("renders as a video frame at the frozen time for its whole length, and survives split and save", () => {
    const { editor, main } = twoClips();
    editor.execute(freezeFrameCommand({ ref: { trackId: main, elementId: "a" }, at: sec(2), duration: sec(3), elementId: "f" }));
    const assets = [videoAsset("asset-a", 6), videoAsset("asset-b", 4)];
    for (const t of [2, 3.5, 4.9]) {
      const layer = buildFramePlan({ tracks: editor.tracks(), canvas, background: bg, assets, time: sec(t) }).items[0] as MediaLayer;
      expect(layer.source).toMatchObject({ type: "video", mediaId: "asset-a", sourceSeconds: 2 });
    }
    editor.execute(splitCommand({ refs: [{ trackId: main, elementId: "f" }], splitTime: sec(3) }));
    expect(editor.tracks().main.elements.filter((e) => (e as ImageElement).freezeAt === sec(2))).toHaveLength(2);
    const loaded = deserializeProject(serializeProject(editor.toProject()));
    expect(loaded.scenes[0]?.tracks.main.elements.filter((e) => (e as ImageElement).freezeAt !== undefined)).toHaveLength(2);
    const broken = JSON.parse(serializeProject(editor.toProject())) as { scenes: Array<{ tracks: { main: { elements: Array<{ freezeAt?: unknown; id: string }> } } }> };
    broken.scenes[0]!.tracks.main.elements.find((e) => e.id === "f")!.freezeAt = -5;
    expect(deserializeProject(broken).repairNotes?.some((n) => /freeze/.test(n))).toBe(true);
  });
  it("the freeze_frame tool reports where things went, in one undo step", async () => {
    const h = setupAgent();
    await h.data("insert_media", { assetId: "a1", start: 0 });
    const tl = await h.data<{ tracks: Array<{ elements: Array<{ id: string }> }> }>("get_timeline");
    const id = tl.tracks.flatMap((t) => t.elements)[0]!.id;
    const out = await h.data<{ freezeId: string; at: number; end: number }>("freeze_frame", { elementId: id, at: 4, duration: 2 });
    expect(out).toMatchObject({ at: 4, end: 6 });
    const clips = h.editor.tracks().main.elements.map((e) => e.type);
    expect(clips.sort()).toEqual(["image", "video", "video"]);
    h.editor.undo();
    expect(h.editor.tracks().main.elements).toHaveLength(1);
    expect((await h.failure("freeze_frame", { elementId: id, at: 99 })).error).toContain("outside");
    expect(allElements(h.editor.tracks())[0]?.element.type).toBe("video");
  });
});
