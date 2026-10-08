import { describe, expect, it } from "vitest";
import { callTool, createAgentTools, type ToolResult } from "#/engine/agent";
import {
  addTrack, createSceneCommand, deleteElements, deleteSceneCommand, duplicateCommand, insertElement, insertElementsOnLanes,
  insertMediaElement, moveElements, pasteCommand, removeAssetsCommand, removeTrackCommand, renameSceneCommand, setElementParams,
  setTrackFlags, splitCommand, toggleBookmark, toggleElementsHidden, toggleElementsMuted, toggleSourceAudio, trimElementCommand,
  updateElements, updateSettings, upsertKeyframeCommand, addClipEffect, addMask,
  type Command,
} from "#/engine/commands";
import { EngineError, orderedTracks, type TimelineElement } from "#/engine/model";
import {
  allElements, buildMoveGroup, buildResizeMembers, computeGroupResize, mintTrackIds, resolveGroupMove, type DropTarget,
} from "#/engine/timeline";
import { TICKS_PER_SECOND, mediaTime } from "#/engine/time";
import type { Editor } from "#/engine/editor";
import { ASSETS } from "./agent-harness";
import { assertEditorHealthy, makeRng, snapshotForUndo } from "./invariants-harness";
import { audio, image, makeEditor, text, video } from "./helpers";

const SEEDS = Array.from({ length: 24 }, (_, i) => i + 1);
const STEPS = 300;

type Rng = ReturnType<typeof makeRng>;

const HOSTILE_NUMBERS = [Number.NaN, Infinity, -Infinity, -1, 0, 0.5, 1, 1e300, -TICKS_PER_SECOND];
const tick = (rng: Rng): number => (rng.chance(0.25) ? rng.pick(HOSTILE_NUMBERS) : rng.int(20 * TICKS_PER_SECOND));
const frameAligned = (rng: Rng, maxSeconds: number): number => Math.floor((rng.next() * maxSeconds * TICKS_PER_SECOND) / 4000) * 4000;

function randomRef(editor: Editor, rng: Rng): { trackId: string; elementId: string } {
  const els = allElements(editor.tracks());
  if (els.length > 0 && rng.chance(0.9)) return rng.pick(els).ref;
  return { trackId: rng.pick(["main", "nope", editor.tracks().main.id]), elementId: rng.pick(["ghost", "x", "a"]) };
}

function randomTrackId(editor: Editor, rng: Rng): string {
  const ids = orderedTracks(editor.tracks()).map((t) => t.id);
  return rng.chance(0.15) ? "unknown-track" : rng.pick(ids);
}

function freshElement(editor: Editor, rng: Rng): TimelineElement {
  const id = rng.chance(0.15) ? rng.pick(allElements(editor.tracks()).map((l) => l.element.id).concat("a")) : editor.newId();
  const start = tick(rng);
  const base = rng.pick([
    () => video(id, 0, 1 + rng.int(6)),
    () => image(id, 0, 1 + rng.int(4)),
    () => audio(id, 0, 1 + rng.int(6)),
    () => text(id, 0, 1 + rng.int(4)),
  ])();
  const element = { ...base, startTime: start as never };
  return rng.chance(0.2) ? ({ ...element, duration: tick(rng) as never } as TimelineElement) : (element as TimelineElement);
}

/** Commands only; arguments are frequently invalid on purpose. */
function randomCommand(editor: Editor, rng: Rng): Command {
  const tracks = editor.tracks();
  const ref = randomRef(editor, rng);
  const assets = editor.getState().doc.assets;
  switch (rng.int(26)) {
    case 0: case 1: return insertElement({ element: freshElement(editor, rng), placement: { mode: "auto" } });
    case 2: return insertElement({ element: freshElement(editor, rng), placement: { mode: "explicit", trackId: randomTrackId(editor, rng) } });
    case 3: return insertElement({ element: freshElement(editor, rng), placement: { mode: "newTrack", index: rng.int(5) - 1, trackId: rng.chance(0.2) ? randomTrackId(editor, rng) : undefined } });
    case 4: return insertMediaElement({ asset: rng.pick(assets.length ? assets : ASSETS), elementId: editor.newId(), startTime: tick(rng), placement: { mode: "auto" } });
    case 5: case 6: return updateElements([{ ref, patch: { startTime: tick(rng) as never } }]);
    case 7: return updateElements([{ ref, patch: { duration: tick(rng) as never } }]);
    case 8: return updateElements([{ ref, patch: { trimStart: tick(rng) as never, trimEnd: tick(rng) as never } }]);
    case 9: return updateElements([{ ref, patch: { retime: { rate: rng.pick([0.5, 2, 3.7, Number.NaN, 0, -1, Infinity]), maintainPitch: false } } as never }]);
    case 10: return splitCommand({ refs: [ref], splitTime: tick(rng) });
    case 11: return trimElementCommand({ ref, start: rng.chance(0.5) ? tick(rng) : undefined, end: rng.chance(0.5) ? tick(rng) : undefined });
    case 12: return deleteElements([ref]);
    case 13: return duplicateCommand([ref]);
    case 14: {
      const items = (() => { const e = allElements(tracks); return e.length ? [rng.pick(e)] : []; })();
      return pasteCommand({ items: items.map((l) => ({ element: l.element, trackType: l.track.type, trackIndex: 0 })) as never, time: tick(rng) });
    }
    case 15: return addTrack({ type: rng.pick(["video", "text", "audio", "graphic"] as const), index: rng.int(6) - 1, trackId: rng.chance(0.3) ? randomTrackId(editor, rng) : undefined });
    case 16: return removeTrackCommand(randomTrackId(editor, rng));
    case 17: return setTrackFlags({ trackId: randomTrackId(editor, rng), muted: rng.chance(0.5), hidden: rng.chance(0.5) });
    case 18: return rng.chance(0.5) ? toggleElementsHidden([ref]) : toggleElementsMuted([ref]);
    case 19: return toggleSourceAudio(ref);
    case 20: return setElementParams({ refs: [ref], params: { opacity: rng.pick([0.3, 1, 5, -2, Number.NaN]) } });
    case 21: return upsertKeyframeCommand({ ref, path: "opacity", time: tick(rng), value: rng.pick([0, 0.5, 1]) });
    case 22: return rng.chance(0.5) ? addClipEffect({ ref, effectType: "blur" }) : addMask(ref, "rectangle");
    case 23: return rng.pick<Command>([
      updateSettings({ canvasSize: { width: rng.pick([1920, 100000, Number.NaN, 640]), height: rng.pick([1080, 480, 0]) } }),
      updateSettings({ fps: { numerator: rng.pick([24, 30, 1000, 0, Number.NaN]), denominator: 1 } }),
      toggleBookmark(tick(rng)),
      removeAssetsCommand(assets.length ? [rng.pick(assets).id] : ["none"]),
    ]);
    case 24: return rng.pick<Command>([
      createSceneCommand({ name: "s" }),
      renameSceneCommand(editor.getState().doc.currentSceneId, "renamed"),
      deleteSceneCommand(rng.pick(editor.getState().doc.scenes).id),
    ]);
    default: return insertElementsOnLanes({ elements: Array.from({ length: 1 + rng.int(4) }, () => ({ ...text(editor.newId(), 0, 1 + rng.int(3)), startTime: frameAligned(rng, 8) as never })) });
  }
}

/** The operations the shipped UI performs with planner-produced arguments. */
function uiOperation(editor: Editor, rng: Rng): void {
  const els = allElements(editor.tracks());
  const sel = els.length ? rng.pick(els) : undefined;
  switch (rng.int(11)) {
    case 0: case 1: {
      const assets = editor.getState().doc.assets;
      const asset = assets[rng.int(Math.min(2, assets.length))];
      if (!asset) return;
      editor.execute(insertMediaElement({ asset, elementId: editor.newId(), startTime: frameAligned(rng, 10), placement: { mode: "auto" } }));
      return;
    }
    case 2: {
      if (!sel) return;
      const tracks = editor.tracks();
      const selection = editor.getState().selection.elements;
      const members = buildMoveGroup({ tracks, anchor: sel.ref, selection: selection.length ? selection : [sel.ref] });
      if (!members) return;
      const target: DropTarget = { trackIndex: rng.int(orderedTracks(tracks).length + 1), isNewTrack: rng.chance(0.3), insertPosition: null, xPosition: mediaTime(0), targetElement: null };
      const plan = resolveGroupMove({ tracks, members, target, anchorStart: frameAligned(rng, 20), newTrackIds: mintTrackIds(members.length, editor.newId) });
      if (plan) editor.execute(moveElements(plan));
      return;
    }
    case 3: case 4: {
      if (!sel) return;
      const members = buildResizeMembers({ tracks: editor.tracks(), refs: [sel.ref] });
      const r = computeGroupResize({ members, side: rng.pick(["left", "right"] as const), delta: Math.round((rng.next() - 0.5) * 6 * TICKS_PER_SECOND), fps: editor.fps() });
      editor.execute(updateElements(r.patches, "Resize"));
      return;
    }
    case 5: if (sel) editor.execute(splitCommand({ refs: [sel.ref], splitTime: sel.element.startTime + frameAligned(rng, sel.element.duration / TICKS_PER_SECOND / 4) })); return;
    case 6: if (sel?.element.type === "video") editor.execute(updateElements([{ ref: sel.ref, patch: { retime: { rate: rng.pick([0.5, 0.75, 1.5, 2, 3.7]), maintainPitch: false } } as never }], "Speed")); return;
    case 7: editor.setRippleEnabled(!editor.getState().rippleEnabled); return;
    case 8: {
      if (!sel) return;
      if (rng.chance(0.5)) {
        editor.execute(duplicateCommand([sel.ref]));
      } else {
        editor.setSelection({ elements: [sel.ref], keyframes: [], keyframeAnchor: null });
        editor.copySelection();
        editor.execute(pasteCommand({ items: editor.clipboard!, time: frameAligned(rng, 10) }));
      }
      return;
    }
    case 9: if (sel) editor.execute(deleteElements([sel.ref])); return;
    default: if (rng.chance(0.5)) editor.undo(); else editor.redo();
  }
}

function toolArgs(editor: Editor, rng: Rng): { name: string; args: Record<string, unknown> } {
  const ids = allElements(editor.tracks()).map((l) => l.element.id);
  const elementId = ids.length && rng.chance(0.9) ? rng.pick(ids) : "ghost";
  const elementIds = ids.length ? Array.from({ length: 1 + rng.int(3) }, () => rng.pick(ids)) : ["ghost"];
  const seconds = (): number => (rng.chance(0.15) ? rng.pick([0, 0.001, -3, 1e9, 0.0004, 7.77777]) : rng.next() * 12);
  const trackId = randomTrackId(editor, rng);
  const placement = rng.pick([{}, { newTrack: true }, { trackId }]);
  const assetId = rng.pick(["a1", "a2", "a3", "music", "photo", "missing"]);
  switch (rng.int(24)) {
    case 0: case 1: return { name: "insert_media", args: { assetId, start: seconds(), ...(rng.chance(0.4) ? { duration: seconds() } : {}), ...placement } };
    case 2: return { name: "insert_text", args: { text: "hi", start: seconds(), duration: seconds(), ...placement } };
    case 3: return { name: "insert_graphic", args: { shape: rng.pick(["rectangle", "star"]), start: seconds(), duration: seconds(), ...placement } };
    case 4: return { name: "insert_effect_layer", args: { effectType: "blur", start: seconds(), duration: seconds(), ...placement } };
    case 5: return { name: "split", args: { at: seconds(), ...(rng.chance(0.6) ? { elementIds } : {}), retain: rng.pick(["both", "left", "right"]) } };
    case 6: return { name: "trim", args: { elementId, ...(rng.chance(0.6) ? { start: seconds() } : {}), ...(rng.chance(0.6) ? { end: seconds() } : {}) } };
    case 7: case 8: return { name: "move", args: { elementIds, ...(rng.chance(0.5) ? { delta: seconds() - 6 } : { start: seconds() }), ...(rng.chance(0.4) ? { trackId } : {}) } };
    case 9: return { name: "delete", args: { elementIds, ripple: rng.chance(0.5) } };
    case 10: return { name: "duplicate", args: { elementIds } };
    case 11: return { name: "set_speed", args: { elementId, speed: rng.pick([0.01, 0.5, 2, 3.3, 5]) } };
    case 12: return { name: "set_params", args: { elementIds, params: { opacity: rng.pick([0.5, 2, -1]), "transform.scale": rng.pick([1, 0, -1]) } } };
    case 13: return { name: "add_keyframe", args: { elementId, property: "opacity", time: seconds(), value: rng.pick([0, 1, 5]) } };
    case 14: return { name: "add_effect", args: { elementId, effectType: "blur" } };
    case 15: return { name: "add_mask", args: { elementId, maskType: rng.pick(["rectangle", "heart", "split"]) } };
    case 16: return { name: "set_track", args: { trackId, muted: rng.chance(0.5), hidden: rng.chance(0.5) } };
    case 17: return { name: "delete_track", args: { trackId } };
    case 18: return { name: "set_project", args: { canvasPreset: rng.pick(["16:9", "9:16", "1:1"]), ...(rng.chance(0.3) ? { fps: rng.pick([24, 30, 60, 120]) } : {}) } };
    case 19: return { name: "add_bookmark", args: { time: seconds() } };
    case 20: return {
      name: "import_captions",
      args: { srt: `1\n00:00:0${rng.int(5)},000 --> 00:00:0${5 + rng.int(4)},000\nOne\n\n2\n00:00:0${rng.int(6)},500 --> 00:00:0${6 + rng.int(3)},000\nTwo\n`, offset: rng.chance(0.5) ? seconds() - 3 : 0 },
    };
    case 21: return { name: rng.pick(["undo", "redo"]), args: { steps: 1 + rng.int(3) } };
    case 22: return { name: "select", args: { elementIds } };
    default: return { name: rng.pick(["get_timeline", "get_project", "list_assets", "get_selection"]), args: {} };
  }
}

function newFuzzEditor(): Editor {
  const { editor } = makeEditor({ assets: ASSETS });
  return editor;
}

function finish(editor: Editor, initial: string, label: string): void {
  assertEditorHealthy(editor, `${label} final`);
  const ids = editor.getState().doc.assets.map((a) => a.id);
  while (editor.undo()) assertEditorHealthy(editor, `${label} while undoing`);
  expect(snapshotForUndo(editor), `${label}: undo-all must return to the initial document`).toBe(initial);
  for (const asset of ASSETS) expect(editor.getState().doc.assets.map((a) => a.id), `${label}: assets only grow under undo`).toContain(asset.id);
  expect(ids.length).toBeGreaterThanOrEqual(0);
}

describe("fuzz: UI-reachable operations", () => {
  for (const seed of SEEDS) {
    it(`seed ${seed} never throws and keeps every invariant`, () => {
      const rng = makeRng(seed);
      const editor = newFuzzEditor();
      const initial = snapshotForUndo(editor);
      for (let step = 0; step < STEPS; step++) {
        try {
          uiOperation(editor, rng);
        } catch (error) {
          throw new Error(`seed ${seed} step ${step}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
        }
        assertEditorHealthy(editor, `seed ${seed} step ${step}`);
      }
      finish(editor, initial, `seed ${seed}`);
    });
  }
});

describe("fuzz: every command with hostile arguments", () => {
  for (const seed of SEEDS) {
    it(`seed ${seed}: rejected commands change nothing, accepted ones keep every invariant`, () => {
      const rng = makeRng(1000 + seed);
      const editor = newFuzzEditor();
      const initial = snapshotForUndo(editor);
      let rejected = 0;
      let accepted = 0;
      for (let step = 0; step < STEPS; step++) {
        const before = editor.getState();
        if (rng.chance(0.15)) {
          uiOperation(editor, rng);
        } else {
          const command = randomCommand(editor, rng);
          let outcome: ReturnType<Editor["tryExecute"]>;
          try {
            outcome = editor.tryExecute(command);
          } catch (error) {
            if (error instanceof EngineError) throw error;
            const state = editor.getState();
            expect(state.doc, `seed ${seed} step ${step} (${command.label}) threw ${String(error)} and must leave the document untouched`).toBe(before.doc);
            expect(state.revision).toBe(before.revision);
            assertEditorHealthy(editor, `seed ${seed} step ${step} after crash of ${command.label}`);
            continue;
          }
          if (outcome.ok) {
            accepted++;
          } else {
            rejected++;
            expect(editor.getState().doc, `seed ${seed} step ${step}: rejected ${command.label} changed the document`).toBe(before.doc);
            expect(editor.getState().revision).toBe(before.revision);
            expect(editor.getState().canUndo).toBe(before.canUndo);
          }
        }
        assertEditorHealthy(editor, `seed ${seed} step ${step}`);
      }
      expect(accepted).toBeGreaterThan(20);
      expect(rejected).toBeGreaterThan(5);
      finish(editor, initial, `seed ${seed}`);
    });
  }
});

describe("fuzz: agent tools", () => {
  const tools = createAgentTools();
  for (const seed of SEEDS) {
    it(`seed ${seed}: no tool call throws, corrupts, or leaves a half-applied edit`, async () => {
      const rng = makeRng(5000 + seed);
      const editor = newFuzzEditor();
      const ctx = { editor, nowMs: () => 0 };
      const initial = snapshotForUndo(editor);
      let succeeded = 0;
      for (let step = 0; step < STEPS; step++) {
        const { name, args } = toolArgs(editor, rng);
        const before = editor.getState().doc;
        let result: ToolResult;
        try {
          result = await callTool({ tools, name, args, ctx });
        } catch (error) {
          throw new Error(`seed ${seed} step ${step}: ${name} threw ${String(error)}`, { cause: error });
        }
        if (result.ok) succeeded++;
        else if (name !== "undo" && name !== "redo") {
          expect(editor.getState().doc, `seed ${seed} step ${step}: failed ${name} ${JSON.stringify(args)} left changes behind`).toBe(before);
        }
        assertEditorHealthy(editor, `seed ${seed} step ${step} after ${name} ${JSON.stringify(args)}`);
      }
      expect(succeeded).toBeGreaterThan(40);
      finish(editor, initial, `seed ${seed}`);
    });
  }
});
