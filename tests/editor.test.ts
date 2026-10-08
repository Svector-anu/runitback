import { describe, expect, it, vi } from "vitest";
import { EMPTY_SELECTION, buildTextElement, type VideoElement } from "#/engine/model";
import {
  addTrack, deleteElements, duplicateCommand, insertElement, insertMediaElement, moveElements, pasteCommand, removeAssetsCommand, splitCommand,
  toggleBookmark, toggleSourceAudio, updateElements, upsertKeyframeCommand, removeKeyframeCommand, addClipEffect,
  addMask, updateSettings, createSceneCommand, toggleTrackMuted, toggleElementsHidden, deleteSceneCommand, batch,
  currentScene, type Command,
} from "#/engine/commands";
import { allElements, getElement, buildMoveGroup, resolveGroupMove, totalDuration } from "#/engine/timeline";
import { resolveNumberAtTime } from "#/engine/animation";
import { runAction } from "#/engine/editor";
import { sec, makeEditor, videoAsset } from "./helpers";

const asset = (id: string, seconds = 10) => ({ ...videoAsset(id, seconds), fps: { numerator: 24, denominator: 1 } });
const tracksOf = (e: ReturnType<typeof makeEditor>["editor"]) => currentScene(e.getState().doc).tracks;

function setup() {
  const a = asset("a1", 10);
  const ctx = makeEditor({ assets: [a] });
  return { ...ctx, a };
}

describe("insert", () => {
  it("first visual media adopts the asset's canvas and fps in the same undo step", () => {
    const portrait = { ...asset("a1", 10), width: 1080, height: 1920 };
    const { editor, a } = { ...makeEditor({ assets: [portrait] }), a: portrait };
    editor.execute(insertMediaElement({ asset: a, elementId: "c1", startTime: 0, placement: { mode: "auto" } }));
    expect(editor.getState().doc.settings.canvasSize).toEqual({ width: 1080, height: 1920 });
    expect(editor.getState().doc.settings.fps).toEqual({ numerator: 24, denominator: 1 });
    expect(editor.getState().doc.settings.originalCanvasSize).toEqual({ width: 1080, height: 1920 });
    editor.undo();
    expect(editor.getState().doc.settings.canvasSize).toEqual({ width: 1920, height: 1080 });
    expect(editor.getState().doc.settings.fps).toEqual({ numerator: 30, denominator: 1 });
  });
  it("selects the new element and positions it on main at the requested time rule", () => {
    const { editor, a } = setup();
    editor.execute(insertMediaElement({ asset: a, elementId: "c1", startTime: sec(3), placement: { mode: "auto" } }));
    const clip = getElement(tracksOf(editor), { trackId: "e-2", elementId: "c1" }) ?? tracksOf(editor).main.elements[0];
    expect(clip?.startTime).toBe(0);
    expect(editor.getState().selection.elements).toHaveLength(1);
  });
  it("a second overlapping insert goes to a new overlay above main", () => {
    const { editor, a } = setup();
    editor.execute(insertMediaElement({ asset: a, elementId: "c1", startTime: 0, placement: { mode: "auto" } }));
    editor.execute(insertMediaElement({ asset: a, elementId: "c2", startTime: sec(2), placement: { mode: "auto" } }));
    expect(tracksOf(editor).overlay).toHaveLength(1);
    expect(totalDuration(tracksOf(editor))).toBe(sec(12));
  });
});

describe("history", () => {
  function twoClips() {
    const s = setup();
    s.editor.execute(insertMediaElement({ asset: s.a, elementId: "c1", startTime: 0, placement: { mode: "auto" } }));
    return s;
  }
  it("undo and redo restore exact states and move selection with them", () => {
    const { editor } = twoClips();
    const afterInsert = editor.getState().doc;
    editor.execute(splitCommand({ refs: [{ trackId: tracksOf(editor).main.id, elementId: "c1" }], splitTime: sec(4) }));
    expect(tracksOf(editor).main.elements).toHaveLength(2);
    expect(editor.undo()).toBe(true);
    expect(editor.getState().doc).toBe(afterInsert);
    expect(editor.redo()).toBe(true);
    expect(tracksOf(editor).main.elements).toHaveLength(2);
    expect(editor.redo()).toBe(false);
  });
  it("a new command clears the redo stack", () => {
    const { editor } = twoClips();
    editor.execute(updateElements([{ ref: { trackId: tracksOf(editor).main.id, elementId: "c1" }, patch: { name: "x" } }]));
    editor.undo();
    expect(editor.getState().canRedo).toBe(true);
    editor.execute(updateElements([{ ref: { trackId: tracksOf(editor).main.id, elementId: "c1" }, patch: { name: "y" } }]));
    expect(editor.getState().canRedo).toBe(false);
  });
  it("batches are one step and undo in reverse", () => {
    const { editor } = twoClips();
    const before = editor.getState().doc;
    editor.execute(batch("add text", [
      addTrack({ type: "text", trackId: "t1" }),
      insertElement({ element: buildTextElement({ id: "tx", startTime: sec(0) }), placement: { mode: "explicit", trackId: "t1" } }),
    ]));
    expect(tracksOf(editor).overlay.map((t) => t.id)).toEqual(["t1"]);
    expect(tracksOf(editor).overlay[0]?.elements).toHaveLength(1);
    editor.undo();
    expect(editor.getState().doc).toBe(before);
  });
  it("no-op commands do not create history", () => {
    const { editor } = twoClips();
    const noop: Command = { label: "noop", run: (doc) => ({ doc }) };
    const revision = editor.getState().revision;
    editor.execute(noop);
    expect(editor.getState().revision).toBe(revision + 1);
    editor.undo();
    expect(editor.getState().doc.scenes[0]?.tracks.main.elements).toHaveLength(0);
  });
  it("history is cleared when another project loads", () => {
    const { editor, project } = twoClips();
    editor.load({ project, assets: [] });
    expect(editor.getState().canUndo).toBe(false);
    expect(editor.undo()).toBe(false);
  });
  it("undo of a scene edit returns to that scene even if the user switched away", () => {
    const { editor } = twoClips();
    const mainId = editor.getState().doc.currentSceneId;
    editor.execute(deleteElements([{ trackId: tracksOf(editor).main.id, elementId: "c1" }]));
    editor.execute(createSceneCommand({ name: "B", sceneId: "sceneB" }));
    expect(editor.getState().doc.currentSceneId).toBe("sceneB");
    editor.undo();
    editor.undo();
    expect(editor.getState().doc.scenes.map((s) => s.id)).toEqual([mainId]);
    expect(editor.getState().doc.currentSceneId).toBe(mainId);
  });
  it("preview does not touch history, revision, or the committed document", () => {
    const { editor } = twoClips();
    const committed = editor.getState().doc;
    const revision = editor.getState().revision;
    const onCommitted = vi.fn();
    editor.onCommitted(onCommitted);
    const ref = { trackId: tracksOf(editor).main.id, elementId: "c1" };
    editor.preview(updateElements([{ ref, patch: { params: { opacity: 0.2 } } }]));
    expect(editor.getState().doc).toBe(committed);
    expect(editor.effectiveDoc().scenes[0]?.tracks.main.elements[0]?.params.opacity).toBe(0.2);
    expect(editor.getState().revision).toBe(revision);
    expect(onCommitted).not.toHaveBeenCalled();
    editor.preview(updateElements([{ ref, patch: { params: { opacity: 0.4 } } }]));
    editor.commitPreview();
    expect(editor.getState().preview).toBeNull();
    expect(onCommitted).toHaveBeenCalledTimes(1);
    expect(tracksOf(editor).main.elements[0]?.params.opacity).toBe(0.4);
    editor.undo();
    expect(tracksOf(editor).main.elements[0]?.params.opacity).toBe(1);
  });
  it("discarding a preview restores the view", () => {
    const { editor } = twoClips();
    editor.preview(updateElements([{ ref: { trackId: tracksOf(editor).main.id, elementId: "c1" }, patch: { params: { opacity: 0 } } }]));
    editor.discardPreview();
    expect(editor.effectiveDoc()).toBe(editor.getState().doc);
  });
});

describe("reactors", () => {
  it("empty overlay tracks vanish after a move empties them and come back on undo", () => {
    const { editor, a } = setup();
    editor.execute(insertMediaElement({ asset: a, elementId: "c1", startTime: 0, placement: { mode: "auto" } }));
    editor.execute(insertMediaElement({ asset: a, elementId: "c2", startTime: 0, placement: { mode: "auto" } }));
    const overlayId = tracksOf(editor).overlay[0]!.id;
    expect(tracksOf(editor).overlay).toHaveLength(1);
    editor.execute(deleteElements([{ trackId: overlayId, elementId: "c2" }]));
    expect(tracksOf(editor).overlay).toHaveLength(0);
    editor.undo();
    expect(tracksOf(editor).overlay).toHaveLength(1);
  });
  it("ripple closes the gap on delete inside the same history step", () => {
    const { editor, a } = setup();
    editor.setRippleEnabled(true);
    editor.execute(insertMediaElement({ asset: a, elementId: "c1", startTime: 0, placement: { mode: "auto" } }));
    editor.execute(insertMediaElement({ asset: a, elementId: "c2", startTime: sec(10), placement: { mode: "auto" } }));
    const main = tracksOf(editor).main.id;
    editor.execute(deleteElements([{ trackId: main, elementId: "c1" }]));
    expect(getElement(tracksOf(editor), { trackId: main, elementId: "c2" })?.startTime).toBe(0);
    editor.undo();
    expect(getElement(tracksOf(editor), { trackId: main, elementId: "c2" })?.startTime).toBe(sec(10));
  });
});

describe("move, duplicate, paste", () => {
  it("move command applies the plan and selects moved clips", () => {
    const { editor, a } = setup();
    editor.execute(insertMediaElement({ asset: a, elementId: "c1", startTime: 0, placement: { mode: "auto" } }));
    editor.execute(insertMediaElement({ asset: a, elementId: "c2", startTime: 0, placement: { mode: "auto" } }));
    const tracks = tracksOf(editor);
    const overlayId = tracks.overlay[0]!.id;
    const members = buildMoveGroup({ tracks, anchor: { trackId: overlayId, elementId: "c2" }, selection: [] })!;
    const plan = resolveGroupMove({ tracks, members, target: { trackIndex: 0, isNewTrack: false, insertPosition: null, xPosition: 0 as never, targetElement: null }, anchorStart: sec(20), newTrackIds: ["z"] })!;
    editor.execute(moveElements(plan));
    expect(getElement(tracksOf(editor), { trackId: overlayId, elementId: "c2" })?.startTime).toBe(sec(20));
    expect(editor.getState().selection.elements).toEqual([{ trackId: overlayId, elementId: "c2" }]);
  });
  it("duplicate, copy and paste round trip with fresh ids", () => {
    const { editor, a } = setup();
    editor.execute(insertMediaElement({ asset: a, elementId: "c1", startTime: 0, placement: { mode: "auto" } }));
    const main = tracksOf(editor).main.id;
    editor.setSelection({ ...EMPTY_SELECTION, elements: [{ trackId: main, elementId: "c1" }] });
    editor.execute(duplicateCommand(editor.selectionRefs()));
    expect(allElements(tracksOf(editor))).toHaveLength(2);
    editor.setSelection({ ...EMPTY_SELECTION, elements: [{ trackId: main, elementId: "c1" }] });
    expect(editor.copySelection()).toBe(true);
    editor.execute(pasteCommand({ items: editor.clipboard!, time: sec(30) }));
    const ids = allElements(tracksOf(editor)).map((l) => l.element.id);
    expect(ids).toHaveLength(3);
    expect(new Set(ids).size).toBe(3);
  });
});

describe("assets", () => {
  it("removing an asset removes its clips and the asset in one undoable step", () => {
    const { editor, a } = setup();
    editor.execute(insertMediaElement({ asset: a, elementId: "c1", startTime: 0, placement: { mode: "auto" } }));
    editor.execute(removeAssetsCommand([a.id]));
    expect(allElements(tracksOf(editor))).toHaveLength(0);
    expect(editor.getState().doc.assets).toHaveLength(0);
    editor.undo();
    expect(allElements(tracksOf(editor))).toHaveLength(1);
    expect(editor.getState().doc.assets).toHaveLength(1);
  });
  it("registerAsset adds without history", () => {
    const { editor } = makeEditor();
    editor.registerAsset(asset("n"));
    expect(editor.getState().doc.assets).toHaveLength(1);
    expect(editor.getState().canUndo).toBe(false);
  });
});

describe("properties", () => {
  it("keyframes: add, evaluate, remove bakes the value", () => {
    const { editor, a } = setup();
    editor.execute(insertMediaElement({ asset: a, elementId: "c1", startTime: 0, placement: { mode: "auto" } }));
    const ref = { trackId: tracksOf(editor).main.id, elementId: "c1" };
    editor.execute(upsertKeyframeCommand({ ref, path: "opacity", time: 0, value: 0 }));
    editor.execute(upsertKeyframeCommand({ ref, path: "opacity", time: sec(10), value: 1 }));
    const el = getElement(tracksOf(editor), ref)!;
    expect(resolveNumberAtTime(el.animations, "opacity", sec(5), 99)).toBeCloseTo(0.5);
    const firstId = Object.values(el.animations!)[0]!.kind === "channel" ? (el.animations!.opacity as { channel: { keys: Array<{ id: string }> } }).channel.keys[0]!.id : "";
    const secondId = (el.animations!.opacity as { channel: { keys: Array<{ id: string }> } }).channel.keys[1]!.id;
    editor.execute(removeKeyframeCommand({ ref, path: "opacity", keyframeId: firstId, localTime: sec(5) }));
    editor.execute(removeKeyframeCommand({ ref, path: "opacity", keyframeId: secondId, localTime: sec(5) }));
    const after = getElement(tracksOf(editor), ref)!;
    expect(after.animations).toBeUndefined();
    expect(after.params.opacity).toBeCloseTo(1);
  });
  it("effects and masks attach to the right element kinds", () => {
    const { editor, a } = setup();
    editor.execute(insertMediaElement({ asset: a, elementId: "c1", startTime: 0, placement: { mode: "auto" } }));
    const ref = { trackId: tracksOf(editor).main.id, elementId: "c1" };
    editor.execute(addClipEffect({ ref, effectType: "blur" }));
    editor.execute(addMask(ref, "ellipse"));
    const el = getElement(tracksOf(editor), ref) as VideoElement;
    expect(el.effects?.[0]).toMatchObject({ type: "blur", enabled: true, params: { intensity: 15 } });
    expect(el.masks?.[0]?.type).toBe("ellipse");
    expect(() => addClipEffect({ ref, effectType: "nope" }).run(editor.getState().doc, { newId: editor.newId, now: () => "" })).toThrow(/Unknown effect/);
  });
  it("track and element visibility/mute toggles", () => {
    const { editor, a } = setup();
    editor.execute(insertMediaElement({ asset: a, elementId: "c1", startTime: 0, placement: { mode: "auto" } }));
    const main = tracksOf(editor).main.id;
    editor.execute(toggleTrackMuted(main));
    expect(tracksOf(editor).main.muted).toBe(true);
    editor.execute(toggleElementsHidden([{ trackId: main, elementId: "c1" }]));
    expect((getElement(tracksOf(editor), { trackId: main, elementId: "c1" }) as VideoElement).hidden).toBe(true);
    editor.execute(toggleElementsHidden([{ trackId: main, elementId: "c1" }]));
    expect((getElement(tracksOf(editor), { trackId: main, elementId: "c1" }) as VideoElement).hidden).toBe(false);
  });
  it("extract audio creates an audio clip and silences the video; recover re-enables it", () => {
    const { editor, a } = setup();
    editor.execute(insertMediaElement({ asset: a, elementId: "c1", startTime: 0, placement: { mode: "auto" } }));
    const ref = { trackId: tracksOf(editor).main.id, elementId: "c1" };
    editor.execute(toggleSourceAudio(ref));
    expect(tracksOf(editor).audio).toHaveLength(1);
    expect((getElement(tracksOf(editor), ref) as VideoElement).isSourceAudioEnabled).toBe(false);
    editor.execute(toggleSourceAudio(ref));
    expect((getElement(tracksOf(editor), ref) as VideoElement).isSourceAudioEnabled).toBe(true);
    expect(tracksOf(editor).audio).toHaveLength(1);
  });
  it("project settings and scenes", () => {
    const { editor } = makeEditor();
    editor.execute(updateSettings({ canvasSize: { width: 1080, height: 1080 } }));
    expect(editor.getState().doc.settings.canvasSize.width).toBe(1080);
    editor.execute(createSceneCommand({ name: "Two", sceneId: "s2" }));
    expect(editor.getState().doc.scenes).toHaveLength(2);
    expect(() => deleteSceneCommand(editor.getState().doc.scenes[0]!.id).run(editor.getState().doc, { newId: editor.newId, now: () => "" })).toThrow(/main scene/);
    editor.execute(deleteSceneCommand("s2"));
    expect(editor.getState().doc.currentSceneId).toBe(editor.getState().doc.scenes[0]!.id);
  });
  it("bookmarks toggle by exact time", () => {
    const { editor } = makeEditor();
    editor.execute(toggleBookmark(sec(2)));
    editor.execute(toggleBookmark(sec(1)));
    expect(currentScene(editor.getState().doc).bookmarks.map((b) => b.time)).toEqual([sec(1), sec(2)]);
    editor.execute(toggleBookmark(sec(2)));
    expect(currentScene(editor.getState().doc).bookmarks).toHaveLength(1);
  });
});

describe("actions", () => {
  function loaded() {
    const s = setup();
    s.editor.execute(insertMediaElement({ asset: s.a, elementId: "c1", startTime: 0, placement: { mode: "auto" } }));
    return s;
  }
  const env = (now = 0) => ({ nowMs: () => now });
  it("split at playhead splits the element under it when nothing is selected", () => {
    const { editor } = loaded();
    editor.clearSelection();
    editor.playback.seek(sec(4));
    expect(runAction(editor, "split", env())).toBe(true);
    expect(tracksOf(editor).main.elements).toHaveLength(2);
    expect(runAction(editor, "split", env())).toBe(true);
  });
  it("split-left keeps the tail, split-right keeps the head", () => {
    const left = loaded();
    left.editor.clearSelection();
    left.editor.playback.seek(sec(4));
    runAction(left.editor, "split-left", env());
    expect(tracksOf(left.editor).main.elements.map((e) => [e.startTime, e.duration])).toEqual([[sec(4), sec(6)]]);
    const right = loaded();
    right.editor.clearSelection();
    right.editor.playback.seek(sec(4));
    runAction(right.editor, "split-right", env());
    expect(tracksOf(right.editor).main.elements.map((e) => [e.startTime, e.duration])).toEqual([[0, sec(4)]]);
  });
  it("delete, undo, redo and select-all", () => {
    const { editor } = loaded();
    expect(runAction(editor, "select-all", env())).toBe(true);
    expect(runAction(editor, "delete-selected", env())).toBe(true);
    expect(allElements(tracksOf(editor))).toHaveLength(0);
    expect(runAction(editor, "undo", env())).toBe(true);
    expect(allElements(tracksOf(editor))).toHaveLength(1);
    expect(runAction(editor, "redo", env())).toBe(true);
    expect(runAction(editor, "delete-selected", env())).toBe(false);
  });
  it("paste only acts when the clipboard has content", () => {
    const { editor } = loaded();
    expect(runAction(editor, "paste-copied", env())).toBe(false);
    runAction(editor, "select-all", env());
    expect(runAction(editor, "copy-selected", env())).toBe(true);
    expect(runAction(editor, "paste-copied", env())).toBe(true);
    expect(allElements(tracksOf(editor))).toHaveLength(2);
  });
  it("transport actions move the playhead on the frame grid and clamp", () => {
    const { editor } = loaded();
    runAction(editor, "frame-step-forward", env());
    expect(editor.playback.getState().currentTime).toBe(5000);
    runAction(editor, "jump-forward", env());
    expect(editor.playback.getState().currentTime).toBe(sec(5) + 5000);
    runAction(editor, "goto-end", env());
    expect(editor.playback.getState().currentTime).toBe(sec(10));
    runAction(editor, "frame-step-forward", env());
    expect(editor.playback.getState().currentTime).toBe(sec(10));
    runAction(editor, "goto-start", env());
    runAction(editor, "frame-step-backward", env());
    expect(editor.playback.getState().currentTime).toBe(0);
  });
  it("toggles snapping and ripple", () => {
    const { editor } = loaded();
    runAction(editor, "toggle-snapping", env());
    expect(editor.getState().snappingEnabled).toBe(false);
    runAction(editor, "toggle-ripple-editing", env());
    expect(editor.getState().rippleEnabled).toBe(true);
  });
  it("cancel-interaction discards a preview, then clears selection", () => {
    const { editor } = loaded();
    const ref = { trackId: tracksOf(editor).main.id, elementId: "c1" };
    editor.preview(updateElements([{ ref, patch: { params: { opacity: 0 } } }]));
    runAction(editor, "cancel-interaction", env());
    expect(editor.getState().preview).toBeNull();
    expect(editor.getState().selection.elements).toHaveLength(0);
  });
});
