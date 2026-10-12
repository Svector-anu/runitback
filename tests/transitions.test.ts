import { describe, expect, it } from "vitest";
import { insertElement, setTransitionCommand, splitCommand, updateElements } from "#/engine/commands";
import { buildFramePlan, easeTransition, isTransitionLayerVisible, transitionLook, type MediaLayer } from "#/engine/render";
import { allElements, assertDocumentInvariants } from "#/engine/timeline";
import { deserializeProject, serializeProject } from "#/engine/persistence";
import type { Editor } from "#/engine/editor";
import { PROJECT_SCHEMA_VERSION, type VideoElement } from "#/engine/model";
import { mediaTime } from "#/engine/time";
import { setupAgent } from "./agent-harness";
import { makeEditor, sec, tracksWith, video, videoAsset } from "./helpers";

const canvas = { width: 1920, height: 1080 };
const bg = { type: "color", color: "#000000" } as const;

function twoClips(): { editor: Editor; a: string; b: string; main: string } {
  const { editor } = makeEditor();
  const main = editor.tracks().main.id;
  editor.execute(insertElement({ element: video("a", 0, 4), placement: { mode: "explicit", trackId: main } }));
  editor.execute(insertElement({ element: video("b", 4, 4), placement: { mode: "explicit", trackId: main } }));
  return { editor, a: "a", b: "b", main };
}
const find = (editor: Editor, id: string): VideoElement => allElements(editor.tracks()).find((l) => l.element.id === id)?.element as VideoElement;
const ref = (main: string, id: string) => ({ trackId: main, elementId: id });

describe("transition look maths", () => {
  it("dissolve fades only the incoming clip; fade-black shows one clip per half", () => {
    expect(transitionLook({ type: "dissolve", role: "in", progress: 0.25 }).alpha).toBe(0.25);
    expect(transitionLook({ type: "dissolve", role: "out", progress: 0.25 }).alpha).toBe(1);
    expect(isTransitionLayerVisible({ type: "fade-black", role: "out", progress: 0.4 })).toBe(true);
    expect(isTransitionLayerVisible({ type: "fade-black", role: "in", progress: 0.4 })).toBe(false);
    expect(transitionLook({ type: "fade-black", role: "out", progress: 0.5 }).darkness).toBe(1);
    expect(transitionLook({ type: "fade-black", role: "in", progress: 1 }).darkness).toBe(0);
  });
  it("slides, wipes and zoom move the right things", () => {
    expect(transitionLook({ type: "slide-left", role: "in", progress: 0 }).shiftX).toBe(1);
    expect(transitionLook({ type: "slide-left", role: "out", progress: 1 }).shiftX).toBe(-1);
    expect(transitionLook({ type: "slide-right", role: "in", progress: 0.5 }).shiftX).toBe(-0.5);
    expect(transitionLook({ type: "wipe-left", role: "in", progress: 0.25 }).revealX).toEqual({ from: 0.75, to: 1 });
    expect(transitionLook({ type: "wipe-right", role: "in", progress: 0.25 }).revealX).toEqual({ from: 0, to: 0.25 });
    expect(transitionLook({ type: "zoom", role: "out", progress: 1 }).scale).toBe(1.5);
    expect(easeTransition(0.5)).toBe(0.5);
  });
});

describe("setTransitionCommand", () => {
  it("sets a transition between touching clips without moving anything, in one undo step", () => {
    const { editor, main } = twoClips();
    const before = JSON.stringify(allElements(editor.tracks()).map((l) => [l.element.id, l.element.startTime, l.element.duration]));
    editor.execute(setTransitionCommand({ ref: ref(main, "b"), transition: { type: "dissolve", duration: sec(1) } }));
    expect(find(editor, "b").transition).toEqual({ type: "dissolve", duration: sec(1) });
    expect(JSON.stringify(allElements(editor.tracks()).map((l) => [l.element.id, l.element.startTime, l.element.duration]))).toBe(before);
    editor.undo();
    expect(find(editor, "b").transition).toBeUndefined();
  });
  it("clamps to half of the shorter neighbour", () => {
    const { editor, main } = twoClips();
    editor.execute(setTransitionCommand({ ref: ref(main, "b"), transition: { type: "zoom", duration: sec(30) } }));
    expect(find(editor, "b").transition?.duration).toBe(sec(2));
  });
  it("rejects a clip with no touching predecessor, and the first clip", () => {
    const { editor, main } = twoClips();
    expect(() => editor.execute(setTransitionCommand({ ref: ref(main, "a"), transition: { type: "dissolve", duration: sec(1) } }))).toThrow(/nothing to transition from/);
    editor.execute(insertElement({ element: video("c", 20, 4), placement: { mode: "explicit", trackId: main } }));
    expect(() => editor.execute(setTransitionCommand({ ref: ref(main, "c"), transition: { type: "dissolve", duration: sec(1) } }))).toThrow(/nothing to transition from/);
  });
  it("is removed in the same undo step when an edit breaks adjacency or shrinks a neighbour", () => {
    const { editor, main } = twoClips();
    editor.execute(setTransitionCommand({ ref: ref(main, "b"), transition: { type: "wipe-left", duration: sec(2) } }));
    editor.execute(updateElements([{ ref: ref(main, "b"), patch: { startTime: sec(6) } }]));
    expect(find(editor, "b").transition).toBeUndefined();
    editor.undo();
    expect(find(editor, "b").transition?.type).toBe("wipe-left");
    editor.execute(updateElements([{ ref: ref(main, "a"), patch: { duration: sec(2) } }]));
    expect(find(editor, "b").transition).toBeUndefined();
  });
  it("the right half of a split does not inherit the transition", () => {
    const { editor, main } = twoClips();
    editor.execute(setTransitionCommand({ ref: ref(main, "b"), transition: { type: "dissolve", duration: sec(1) } }));
    editor.execute(splitCommand({ refs: [ref(main, "b")], splitTime: sec(6) }));
    const transitions = allElements(editor.tracks()).filter((l) => (l.element as VideoElement).transition);
    expect(transitions.map((l) => l.element.id)).toEqual(["b"]);
    assertDocumentInvariants(editor.getState().doc);
  });
});

describe("buildFramePlan with transitions", () => {
  const withTransition = (extraB: Partial<VideoElement> = {}, type: VideoElement["transition"] = { type: "dissolve", duration: mediaTime(sec(1)) }) =>
    tracksWith({ main: [video("a", 0, 4), video("b", 4, 4, { transition: type, ...extraB })] });
  const plan = (tracks: ReturnType<typeof tracksWith>, t: number) =>
    buildFramePlan({ tracks, canvas, background: bg, assets: [videoAsset("asset-a", 4), videoAsset("asset-b", 4)], time: t });

  it("outside the window nothing changes", () => {
    const tracks = withTransition();
    expect(plan(tracks, sec(3.4)).items.map((i) => i.elementId)).toEqual(["a"]);
    expect((plan(tracks, sec(3.4)).items[0] as MediaLayer).transition).toBeNull();
    expect(plan(tracks, sec(4.5)).items.map((i) => i.elementId)).toEqual(["b"]);
  });
  it("blends both clips across a window centred on the cut", () => {
    const tracks = withTransition();
    const start = plan(tracks, sec(3.5)).items as MediaLayer[];
    expect(start.map((i) => [i.elementId, i.transition?.role, i.transition?.progress])).toEqual([["a", "out", 0], ["b", "in", 0]]);
    const mid = plan(tracks, sec(4)).items as MediaLayer[];
    expect(mid.map((i) => i.transition?.progress)).toEqual([0.5, 0.5]);
    const after = plan(tracks, sec(4.25)).items as MediaLayer[];
    expect(after.map((i) => i.elementId)).toEqual(["a", "b"]);
  });
  it("holds the first/last frame where the source has no handles", () => {
    const tracks = withTransition();
    const [a, b] = plan(tracks, sec(3.75)).items as MediaLayer[];
    expect(b?.source).toMatchObject({ sourceSeconds: 0 });
    const [a2] = plan(tracks, sec(4.25)).items as MediaLayer[];
    expect((a2?.source as { sourceSeconds: number }).sourceSeconds).toBeLessThan(4);
    expect((a2?.source as { sourceSeconds: number }).sourceSeconds).toBeGreaterThan(3.9);
    expect(a?.source).toMatchObject({ sourceSeconds: 3.75 });
  });
  it("uses source handles when the clip was trimmed", () => {
    const tracks = tracksWith({ main: [
      video("a", 0, 4), video("b", 4, 4, { trimStart: sec(2), sourceDuration: sec(10), trimEnd: sec(4), transition: { type: "zoom", duration: sec(1) } }),
    ] });
    const [, b] = plan(tracks, sec(3.75)).items as MediaLayer[];
    expect(b?.source).toMatchObject({ sourceSeconds: 1.75 });
  });
  it("fade through black draws one clip at a time", () => {
    const tracks = withTransition({}, { type: "fade-black", duration: sec(1) });
    expect(plan(tracks, sec(3.6)).items.map((i) => i.elementId)).toEqual(["a"]);
    expect(plan(tracks, sec(4.3)).items.map((i) => i.elementId)).toEqual(["b"]);
  });
  it("a transition whose neighbour is not touching is ignored", () => {
    const tracks = tracksWith({ main: [video("a", 0, 4), video("b", 5, 4, { transition: { type: "dissolve", duration: sec(1) } })] });
    expect(plan(tracks, sec(4.9)).items).toHaveLength(0);
  });
});

describe("persistence", () => {
  it("round-trips a transition and drops one that no longer fits", () => {
    const { editor, main } = twoClips();
    editor.execute(setTransitionCommand({ ref: ref(main, "b"), transition: { type: "slide-left", duration: sec(1) } }));
    const json = serializeProject(editor.toProject());
    const loaded = deserializeProject(json);
    expect(loaded.version).toBe(PROJECT_SCHEMA_VERSION);
    expect((loaded.scenes[0]?.tracks.main.elements[1] as VideoElement).transition?.type).toBe("slide-left");
    const broken = JSON.parse(json) as { scenes: Array<{ tracks: { main: { elements: Array<{ startTime: number; transition?: unknown }> } } }> };
    const second = broken.scenes[0]!.tracks.main.elements[1]!;
    second.startTime += sec(1);
    const repaired = deserializeProject(broken);
    expect((repaired.scenes[0]?.tracks.main.elements[1] as VideoElement).transition).toBeUndefined();
    second.transition = { type: "nope", duration: 5 };
    expect(deserializeProject(broken).repairNotes?.some((n) => /transition/.test(n))).toBe(true);
  });
  it("migrates a v1 project unchanged", () => {
    const { editor } = twoClips();
    const v1 = { ...JSON.parse(serializeProject(editor.toProject())) as object, version: 1 };
    expect(deserializeProject(v1).version).toBe(PROJECT_SCHEMA_VERSION);
  });
});

describe("agent tools", () => {
  async function agentWithClips() {
    const h = setupAgent();
    await h.data("insert_media", { assetId: "a1", start: 0 });
    await h.data("insert_media", { assetId: "a2", start: 10 });
    const tl = await h.data<{ tracks: Array<{ elements: Array<{ id: string }> }> }>("get_timeline");
    const ids = tl.tracks.flatMap((t) => t.elements.map((e) => e.id));
    return { h, ids };
  }
  it("set_transition and add_transition apply in one undo step and report clamping", async () => {
    const { h, ids } = await agentWithClips();
    const [first, second] = ids as [string, string];
    const out = await h.data<{ transitions: Array<{ duration: number; clamped: boolean }> }>("set_transition", { elementIds: [second], type: "dissolve", duration: 99 });
    expect(out.transitions[0]).toMatchObject({ duration: 4, clamped: true });
    const undoDepth = h.editor.getState().canUndo;
    expect(undoDepth).toBe(true);
    await h.data("add_transition", { fromElementId: first, toElementId: second, type: "zoom", duration: 1 });
    expect(find(h.editor, second).transition).toMatchObject({ type: "zoom", duration: sec(1) });
    h.editor.undo();
    expect(find(h.editor, second).transition).toMatchObject({ type: "dissolve" });
    await h.data("remove_transition", { elementIds: [second] });
    expect(find(h.editor, second).transition).toBeUndefined();
  });
  it("explains gaps and wrong order instead of guessing", async () => {
    const { h, ids } = await agentWithClips();
    const [first, second] = ids as [string, string];
    expect((await h.failure("add_transition", { fromElementId: second, toElementId: first, type: "dissolve" })).error).toContain("does not end where");
    await h.data("move", { elementIds: [second], delta: 3 });
    expect((await h.failure("set_transition", { elementIds: [second], type: "dissolve" })).hint).toContain("touching");
    expect((await h.failure("set_transition", { elementIds: [second], type: "spin" })).error).toBeTruthy();
  });
});
