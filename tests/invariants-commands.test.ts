import { describe, expect, it, vi } from "vitest";
import {
  addTrack, batch, deleteElements, insertElement, insertElementsOnLanes, moveElements, pasteCommand, removeAssetsCommand,
  setElementParams, splitCommand, toggleBookmark, trimElementCommand, updateElements, updateSettings, MAX_HISTORY_ENTRIES,
  type Command,
} from "#/engine/commands";
import {
  buildMediaElement, EngineError, InvalidInputError, InvariantViolationError, type MediaAssetInfo, type TimelineElement,
} from "#/engine/model";
import { allElements, assertDocumentInvariants, buildMoveGroup, mintTrackIds, resolveGroupMove, type DropTarget } from "#/engine/timeline";
import { mediaTime } from "#/engine/time";
import type { Editor } from "#/engine/editor";
import { makeEditor, sec, text, video } from "./helpers";

function seeded(): { editor: Editor; mainId: string } {
  const { editor } = makeEditor();
  const mainId = editor.tracks().main.id;
  editor.execute(insertElement({ element: video("a", 0, 5), placement: { mode: "explicit", trackId: mainId } }));
  return { editor, mainId };
}

const elementOf = (editor: Editor, id: string): TimelineElement =>
  allElements(editor.tracks()).find((l) => l.element.id === id)!.element;

/** The command must be rejected with a typed error and leave document, history and listeners untouched. */
function expectRejected(editor: Editor, command: Command, type: abstract new (...args: never[]) => EngineError = EngineError): EngineError {
  const doc = editor.getState().doc;
  const revision = editor.getState().revision;
  const canUndo = editor.getState().canUndo;
  const committed = vi.fn();
  const off = editor.onCommitted(committed);
  const outcome = editor.tryExecute(command);
  off();
  expect(outcome.ok).toBe(false);
  if (outcome.ok) throw new Error("unreachable");
  expect(outcome.error).toBeInstanceOf(type);
  expect(editor.getState().doc).toBe(doc);
  expect(editor.getState().revision).toBe(revision);
  expect(editor.getState().canUndo).toBe(canUndo);
  expect(committed).not.toHaveBeenCalled();
  expect(() => editor.duration()).not.toThrow();
  expect(() => editor.toProject()).not.toThrow();
  return outcome.error;
}

describe("overlap invariants at the command layer", () => {
  it("E1 explicit insert onto an occupied span is rejected", () => {
    const { editor, mainId } = seeded();
    expectRejected(editor, insertElement({ element: video("b", 2, 5), placement: { mode: "explicit", trackId: mainId } }), InvalidInputError);
  });

  it("E1 explicit insert into free space and touching edges is accepted", () => {
    const { editor, mainId } = seeded();
    editor.execute(insertElement({ element: video("b", 5, 5), placement: { mode: "explicit", trackId: mainId } }));
    assertDocumentInvariants(editor.getState().doc);
    expect(allElements(editor.tracks())).toHaveLength(2);
  });

  it("E2 a startTime patch that lands on a neighbour is rejected", () => {
    const { editor, mainId } = seeded();
    editor.execute(insertElement({ element: video("b", 10, 5), placement: { mode: "explicit", trackId: mainId } }));
    expectRejected(editor, updateElements([{ ref: { trackId: mainId, elementId: "b" }, patch: { startTime: sec(3) } }]), InvariantViolationError);
  });

  it("E4 pinning a main-track clip to 0 over the first clip is rejected, in the pipeline and for explicit insert", () => {
    const { editor, mainId } = seeded();
    editor.execute(insertElement({ element: video("b", 20, 30), placement: { mode: "explicit", trackId: mainId } }));
    expectRejected(editor, updateElements([{ ref: { trackId: mainId, elementId: "b" }, patch: { startTime: sec(0) } }]), InvariantViolationError);
    expectRejected(editor, insertElement({ element: video("c", 0, 1), placement: { mode: "explicit", trackId: mainId } }));
  });

  it("a duration patch that grows into the next clip is rejected", () => {
    const { editor, mainId } = seeded();
    editor.execute(insertElement({ element: { ...video("b", 6, 1), sourceDuration: sec(20), trimEnd: sec(19) }, placement: { mode: "explicit", trackId: mainId } }));
    editor.execute(updateElements([{ ref: { trackId: mainId, elementId: "a" }, patch: { duration: sec(2) } }]));
    expect(elementOf(editor, "a").duration).toBe(sec(2));
    expectRejected(editor, updateElements([{ ref: { trackId: mainId, elementId: "a" }, patch: { duration: sec(7) } }]));
  });

  it("a paste that would collide is placed elsewhere, never overlapping", () => {
    const { editor, mainId } = seeded();
    editor.setSelection({ elements: [{ trackId: mainId, elementId: "a" }], keyframes: [], keyframeAnchor: null });
    editor.copySelection();
    editor.execute(pasteCommand({ items: editor.clipboard!, time: sec(1) }));
    assertDocumentInvariants(editor.getState().doc);
  });

  it("a stale move plan is rejected cleanly", () => {
    const { editor, mainId } = seeded();
    const tracks = editor.tracks();
    const members = buildMoveGroup({ tracks, anchor: { trackId: mainId, elementId: "a" }, selection: [{ trackId: mainId, elementId: "a" }] })!;
    const target: DropTarget = { trackIndex: 0, isNewTrack: true, insertPosition: null, xPosition: mediaTime(0), targetElement: null };
    const plan = resolveGroupMove({ tracks, members, target, anchorStart: sec(3), newTrackIds: mintTrackIds(1, editor.newId) })!;
    editor.execute(deleteElements([{ trackId: mainId, elementId: "a" }]));
    expect(editor.tryExecute(moveElements(plan)).ok).toBe(false);
    expect(allElements(editor.tracks())).toHaveLength(0);
  });

  it("E10 a stale drag plan makes preview return false instead of throwing, and leaves no preview behind", () => {
    const { editor, mainId } = seeded();
    const tracks = editor.tracks();
    const members = buildMoveGroup({ tracks, anchor: { trackId: mainId, elementId: "a" }, selection: [{ trackId: mainId, elementId: "a" }] })!;
    const target: DropTarget = { trackIndex: 0, isNewTrack: true, insertPosition: null, xPosition: mediaTime(0), targetElement: null };
    const plan = resolveGroupMove({ tracks, members, target, anchorStart: sec(3), newTrackIds: mintTrackIds(1, editor.newId) })!;
    editor.execute(deleteElements([{ trackId: mainId, elementId: "a" }]));
    expect(editor.preview(moveElements(plan))).toBe(false);
    expect(editor.isPreviewing).toBe(false);
    expect(editor.commitPreview()).toBe(false);
  });

  it("an invalid preview falls back to the committed document", () => {
    const { editor, mainId } = seeded();
    expect(editor.preview(updateElements([{ ref: { trackId: mainId, elementId: "a" }, patch: { duration: sec(2) } }]))).toBe(true);
    expect(editor.preview(updateElements([{ ref: { trackId: mainId, elementId: "a" }, patch: { duration: Number.NaN as never } }]))).toBe(false);
    expect(editor.isPreviewing).toBe(false);
    expect(editor.tracks().main.elements[0]!.duration).toBe(sec(5));
  });
});

describe("numeric validation at the command boundary", () => {
  const hostile: Array<[string, number]> = [["NaN", Number.NaN], ["Infinity", Infinity], ["-Infinity", -Infinity], ["fraction", 0.5], ["1e300", 1e300]];

  for (const [label, value] of hostile) {
    it(`E3 element patches with ${label} are rejected and the editor stays usable`, () => {
      const { editor, mainId } = seeded();
      const ref = { trackId: mainId, elementId: "a" };
      for (const field of ["startTime", "duration", "trimStart", "trimEnd"] as const) {
        expectRejected(editor, updateElements([{ ref, patch: { [field]: value } }]), InvalidInputError);
      }
      expectRejected(editor, splitCommand({ refs: [ref], splitTime: value }), InvalidInputError);
      expectRejected(editor, trimElementCommand({ ref, start: value }), InvalidInputError);
      expectRejected(editor, trimElementCommand({ ref, end: value }), InvalidInputError);
      expectRejected(editor, toggleBookmark(value), InvalidInputError);
      expectRejected(editor, pasteCommand({ items: [], time: value }), InvalidInputError);
      expectRejected(editor, insertElement({ element: { ...video("n", 10, 1), startTime: value as never }, placement: { mode: "auto" } }), InvalidInputError);
      expectRejected(editor, insertElement({ element: { ...video("n", 10, 1), duration: value as never }, placement: { mode: "auto" } }), InvalidInputError);
      expect(Number.isFinite(editor.duration())).toBe(true);
    });
  }

  it("E3 negative and zero durations and negative trims are rejected", () => {
    const { editor, mainId } = seeded();
    const ref = { trackId: mainId, elementId: "a" };
    expectRejected(editor, updateElements([{ ref, patch: { duration: -5 as never } }]), InvalidInputError);
    expectRejected(editor, updateElements([{ ref, patch: { duration: 0 as never } }]), InvalidInputError);
    expectRejected(editor, updateElements([{ ref, patch: { trimStart: -1 as never } }]), InvalidInputError);
  });

  it("E3 a duration longer than the source is rejected; a shorter one moves the tail trim", () => {
    const { editor, mainId } = seeded();
    const ref = { trackId: mainId, elementId: "a" };
    expectRejected(editor, updateElements([{ ref, patch: { duration: sec(500) } }]), InvalidInputError);
    editor.execute(updateElements([{ ref, patch: { duration: sec(2) } }]));
    const a = elementOf(editor, "a");
    if (a.type !== "video") throw new Error("expected video");
    expect(a.trimStart + a.duration + a.trimEnd).toBe(a.sourceDuration);
  });

  it("E3 a negative start is clamped to zero as before, not stored", () => {
    const { editor } = seeded();
    editor.execute(insertElement({ element: video("b", 10, 1), placement: { mode: "newTrack", index: 0 } }));
    const trackId = allElements(editor.tracks()).find((l) => l.element.id === "b")!.ref.trackId;
    editor.execute(updateElements([{ ref: { trackId, elementId: "b" }, patch: { startTime: mediaTime(-sec(3)) } }]));
    expect(elementOf(editor, "b").startTime).toBe(0);
  });

  it("E3d poisoned input never reaches serialization", () => {
    const { editor, mainId } = seeded();
    editor.tryExecute(updateElements([{ ref: { trackId: mainId, elementId: "a" }, patch: { duration: Number.NaN as never, startTime: Infinity as never } }]));
    expect(JSON.stringify(editor.toProject().scenes)).not.toContain("null");
  });

  it("E6 zero-duration elements are rejected", () => {
    const { editor, mainId } = seeded();
    expectRejected(editor, insertElement({ element: { ...video("z", 10, 1), duration: mediaTime(0) }, placement: { mode: "explicit", trackId: mainId } }), InvalidInputError);
  });

  it("E9 a fractional split time is a typed error, not a RangeError", () => {
    const { editor, mainId } = seeded();
    const error = expectRejected(editor, splitCommand({ refs: [{ trackId: mainId, elementId: "a" }], splitTime: sec(1) + 0.5 }), InvalidInputError);
    expect(error).not.toBeInstanceOf(RangeError);
  });

  it("keyframe times that are NaN surface as typed errors", async () => {
    const { upsertKeyframeCommand } = await import("#/engine/commands");
    const { editor, mainId } = seeded();
    expectRejected(editor, upsertKeyframeCommand({ ref: { trackId: mainId, elementId: "a" }, path: "opacity", time: Number.NaN, value: 0.5 }));
  });

  it("project settings outside the supported range are rejected", () => {
    const { editor } = seeded();
    expectRejected(editor, updateSettings({ canvasSize: { width: 100000, height: 100000 } }), InvalidInputError);
    expectRejected(editor, updateSettings({ canvasSize: { width: Number.NaN, height: 100 } }), InvalidInputError);
    expectRejected(editor, updateSettings({ fps: { numerator: 1000, denominator: 1 } }), InvalidInputError);
    editor.execute(updateSettings({ fps: { numerator: 24, denominator: 1 } }));
  });
});

describe("identity invariants", () => {
  it("E5 inserting a duplicate element id is rejected, so delete-by-id cannot remove two clips", () => {
    const { editor, mainId } = seeded();
    expectRejected(editor, insertElement({ element: video("a", 10, 2), placement: { mode: "explicit", trackId: mainId } }), InvalidInputError);
    expect(allElements(editor.tracks()).filter((l) => l.element.id === "a")).toHaveLength(1);
  });

  it("duplicate track ids are rejected by addTrack and newTrack placement", () => {
    const { editor, mainId } = seeded();
    expectRejected(editor, addTrack({ type: "text", trackId: mainId }), InvalidInputError);
    expectRejected(editor, insertElement({ element: text("t", 0), placement: { mode: "newTrack", index: 0, trackId: mainId } }), InvalidInputError);
  });

  it("a command that returns a corrupt document is refused before it is committed", () => {
    const { editor } = seeded();
    const corrupt: Command = {
      label: "corrupt",
      run: (doc) => ({
        doc: { ...doc, scenes: doc.scenes.map((s) => ({ ...s, tracks: { ...s.tracks, main: { ...s.tracks.main, elements: [{ ...video("x", 0, 1), duration: Number.NaN as never }] } } })) },
      }),
    };
    expectRejected(editor, corrupt, InvariantViolationError);
  });

  it("a command that throws midway leaves the editor untouched", () => {
    const { editor } = seeded();
    const boom: Command = { label: "boom", run: () => { throw new Error("boom"); } };
    const doc = editor.getState().doc;
    expect(() => editor.execute(boom)).toThrow("boom");
    expect(editor.getState().doc).toBe(doc);
  });

  it("a batch that fails on its last command applies nothing", () => {
    const { editor, mainId } = seeded();
    const doc = editor.getState().doc;
    const outcome = editor.tryExecute(batch("two", [
      insertElement({ element: video("b", 10, 1), placement: { mode: "explicit", trackId: mainId } }),
      insertElement({ element: video("c", 2, 1), placement: { mode: "explicit", trackId: mainId } }),
    ]));
    expect(outcome.ok).toBe(false);
    expect(editor.getState().doc).toBe(doc);
  });

  it("pre-existing damage does not lock a document, but edits may not add new damage", () => {
    const { editor } = makeEditor();
    const mainId = editor.tracks().main.id;
    const a = video("a", 0, 5);
    const b = video("b", 2, 5);
    editor.load({
      project: { ...editor.toProject(), scenes: editor.getState().doc.scenes.map((s) => ({ ...s, tracks: { ...s.tracks, main: { ...s.tracks.main, elements: [a, b] } } })) },
      assets: [],
    });
    editor.execute(setElementParams({ refs: [{ trackId: mainId, elementId: "a" }], params: { opacity: 0.5 } }));
    expectRejected(editor, insertElement({ element: video("c", 3, 1), placement: { mode: "explicit", trackId: mainId } }));
  });
});

describe("caption-style imports", () => {
  it("overlapping cues land on separate text tracks and nothing overlaps", () => {
    const { editor } = seeded();
    const cues = [text("c1", 0, 3), text("c2", 1, 3), text("c3", 2, 1), text("c4", 5, 1)];
    editor.execute(insertElementsOnLanes({ elements: cues }));
    const textTracks = [...editor.tracks().overlay].filter((t) => t.type === "text");
    expect(textTracks.length).toBe(3);
    assertDocumentInvariants(editor.getState().doc);
    expect(allElements(editor.tracks()).filter((l) => l.track.type === "text")).toHaveLength(4);
    expect(editor.undo()).toBe(true);
    expect(editor.tracks().overlay).toHaveLength(0);
  });

  it("non-overlapping cues share one track; duplicate ids in the batch are rejected", () => {
    const { editor } = seeded();
    editor.execute(insertElementsOnLanes({ elements: [text("c1", 0, 1), text("c2", 1, 1), text("c3", 3, 1)] }));
    expect(editor.tracks().overlay).toHaveLength(1);
    expectRejected(editor, insertElementsOnLanes({ elements: [text("d1", 10, 1), text("d1", 12, 1)] }), InvalidInputError);
  });
});

describe("assets are monotonic across undo and redo", () => {
  const asset = (id: string): MediaAssetInfo => ({ id, name: `${id}.mp4`, type: "video", size: 1, lastModified: 0, width: 10, height: 10, duration: sec(2), hasAudio: false });

  it("E7 undoing past an import keeps the asset and its id in the saved project", () => {
    const { editor, mainId } = seeded();
    const late = asset("late");
    editor.execute(setElementParams({ refs: [{ trackId: mainId, elementId: "a" }], params: { opacity: 0.5 } }));
    editor.registerAsset(late);
    editor.execute(insertElement({ element: buildMediaElement({ id: "late-el", startTime: mediaTime(sec(100)), asset: late }), placement: { mode: "auto" } }));
    editor.undo();
    editor.undo();
    expect(editor.getState().doc.assets.map((a) => a.id)).toContain("late");
    expect(editor.toProject().assetIds).toContain("late");
    editor.redo();
    editor.redo();
    expect(editor.getState().doc.assets.map((a) => a.id)).toContain("late");
    expect(allElements(editor.tracks()).some((l) => l.element.id === "late-el")).toBe(true);
  });

  it("E7b an asset registered between undo and redo survives the redo", () => {
    const { editor, mainId } = seeded();
    editor.execute(setElementParams({ refs: [{ trackId: mainId, elementId: "a" }], params: { opacity: 0.5 } }));
    editor.undo();
    editor.registerAsset(asset("late2"));
    editor.redo();
    expect(editor.getState().doc.assets.map((a) => a.id)).toContain("late2");
  });

  it("removing an asset is one undoable step: undo restores asset and clips, redo removes them again", () => {
    const own = asset("keep");
    const { editor } = makeEditor({ assets: [own] });
    const el = buildMediaElement({ id: "k1", startTime: mediaTime(0), asset: own });
    editor.execute(insertElement({ element: el, placement: { mode: "auto" } }));
    editor.execute(removeAssetsCommand(["keep"]));
    expect(editor.getState().doc.assets).toHaveLength(0);
    expect(allElements(editor.tracks())).toHaveLength(0);
    expect(editor.toProject().assetIds).toContain("keep");
    editor.undo();
    expect(editor.getState().doc.assets.map((a) => a.id)).toEqual(["keep"]);
    expect(allElements(editor.tracks())).toHaveLength(1);
    editor.redo();
    expect(editor.getState().doc.assets).toHaveLength(0);
  });

  it("assetIds never drop an asset a scene still references", () => {
    const own = asset("used");
    const { editor } = makeEditor({ assets: [own] });
    editor.execute(insertElement({ element: buildMediaElement({ id: "u1", startTime: mediaTime(0), asset: own }), placement: { mode: "auto" } }));
    editor.load({ project: editor.toProject(), assets: [] });
    expect(editor.toProject().assetIds).toContain("used");
  });

  it("rolling back a transaction keeps assets registered inside it", () => {
    const { editor, mainId } = seeded();
    editor.beginTransaction("turn");
    editor.registerAsset(asset("mid"));
    editor.execute(setElementParams({ refs: [{ trackId: mainId, elementId: "a" }], params: { opacity: 0.2 } }));
    editor.rollbackTransaction();
    expect(editor.getState().doc.assets.map((a) => a.id)).toContain("mid");
  });

  it("rolling back a transaction restores an asset removed inside it", () => {
    const own = asset("rm");
    const { editor } = makeEditor({ assets: [own] });
    editor.beginTransaction("turn");
    editor.execute(removeAssetsCommand(["rm"]));
    editor.rollbackTransaction();
    expect(editor.getState().doc.assets.map((a) => a.id)).toEqual(["rm"]);
  });
});

describe("history", () => {
  it("is capped so long sessions cannot grow without bound", () => {
    const { editor, mainId } = seeded();
    const ref = { trackId: mainId, elementId: "a" };
    for (let i = 0; i < MAX_HISTORY_ENTRIES + 25; i++) editor.execute(setElementParams({ refs: [ref], params: { opacity: (i % 10) / 10 } }));
    let steps = 0;
    while (editor.undo()) steps++;
    expect(steps).toBe(MAX_HISTORY_ENTRIES);
  });
});
