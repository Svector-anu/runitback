import { describe, expect, it } from "vitest";
import { freezeFrameCommand, insertElement, setTransitionCommand } from "#/engine/commands";
import { mediaTime } from "#/engine/time";
import { allElements } from "#/engine/timeline";
import { TICKS_PER_SECOND } from "#/engine/time";
import { DEFAULT_FREEZE_TICKS, freezeAvailability } from "../src/ui/timeline/freeze";
import { DEFAULT_TRANSITION_TICKS, defaultTransitionDuration, findCuts, transitionRange } from "../src/ui/timeline/transitions";
import { ANIMATION_CHOICES, sideState, textAnimationCommand } from "../src/ui/properties/text-animation-logic";
import { makeEditor, sec, text, tracksWith, video } from "./helpers";
import type { TextElement } from "#/engine/model";

describe("findCuts", () => {
  it("finds only touching video/image clips, in time order, with the engine's limit", () => {
    const tracks = tracksWith({ main: [video("a", 0, 4), video("b", 4, 2), video("c", 7, 3), video("d", 10, 1)] });
    const cuts = findCuts(tracks.main);
    expect(cuts.map((c) => [c.outgoing.id, c.incoming.id])).toEqual([["a", "b"], ["c", "d"]]);
    expect(cuts[0]!.max).toBe(sec(1));
    expect(cuts[1]!.max).toBe(Math.floor(sec(1) / 2));
    expect(cuts.every((c) => c.transition === null)).toBe(true);
  });
  it("reports an existing transition with its clamped duration", () => {
    const tracks = tracksWith({ main: [video("a", 0, 4), video("b", 4, 2, { transition: { type: "dissolve", duration: mediaTime(sec(30)) } })] });
    expect(findCuts(tracks.main)[0]!.transition).toEqual({ type: "dissolve", duration: sec(1) });
  });
  it("finds nothing on a single clip or with a gap", () => {
    expect(findCuts(tracksWith({ main: [video("a", 0, 4)] }).main)).toEqual([]);
    expect(findCuts(tracksWith({ main: [video("a", 0, 4), video("b", 5, 4)] }).main)).toEqual([]);
  });
});

describe("transition duration helpers", () => {
  it("defaults to one second, capped by what the clips allow", () => {
    expect(defaultTransitionDuration(sec(5))).toBe(DEFAULT_TRANSITION_TICKS);
    expect(defaultTransitionDuration(sec(0.4))).toBe(sec(0.4));
  });
  it("is unusable when the clips are too short to lengthen", () => {
    expect(transitionRange(sec(2))).toMatchObject({ min: sec(0.1), max: sec(2), usable: true });
    expect(transitionRange(sec(0.05)).usable).toBe(false);
  });
  it("set / change / remove through the engine command is undoable one step at a time", () => {
    const { editor } = makeEditor();
    const main = editor.tracks().main.id;
    editor.execute(insertElement({ element: video("a", 0, 4), placement: { mode: "explicit", trackId: main } }));
    editor.execute(insertElement({ element: video("b", 4, 4), placement: { mode: "explicit", trackId: main } }));
    const ref = { trackId: main, elementId: "b" };
    const incoming = () => allElements(editor.tracks()).find((l) => l.element.id === "b")!.element as { transition?: { type: string; duration: number } };
    editor.execute(setTransitionCommand({ ref, transition: { type: "dissolve", duration: mediaTime(sec(1)) } }));
    editor.preview(setTransitionCommand({ ref, transition: { type: "dissolve", duration: mediaTime(sec(1.5)) } }));
    editor.execute(setTransitionCommand({ ref, transition: { type: "dissolve", duration: mediaTime(sec(1.5)) } }));
    expect(incoming().transition?.duration).toBe(sec(1.5));
    editor.undo();
    expect(incoming().transition?.duration).toBe(sec(1));
    editor.execute(setTransitionCommand({ ref, transition: null }));
    expect(incoming().transition).toBeUndefined();
    editor.undo();
    expect(incoming().transition?.type).toBe("dissolve");
  });
});

describe("freezeAvailability", () => {
  const clip = video("a", 2, 4);
  it("needs a video clip with the playhead inside it", () => {
    expect(freezeAvailability(clip, sec(3))).toEqual({ ok: true });
    expect(freezeAvailability(clip, sec(2))).toEqual({ ok: true });
    expect(freezeAvailability(clip, sec(6)).ok).toBe(false);
    expect(freezeAvailability(clip, sec(1)).ok).toBe(false);
    expect(freezeAvailability(text("t", 0), sec(1)).ok).toBe(false);
    expect(freezeAvailability(undefined, 0).ok).toBe(false);
  });
  it("the default freeze inserts a two second still at the playhead", () => {
    const { editor } = makeEditor();
    const main = editor.tracks().main.id;
    editor.execute(insertElement({ element: video("a", 0, 6), placement: { mode: "explicit", trackId: main } }));
    editor.execute(freezeFrameCommand({ ref: { trackId: main, elementId: "a" }, at: sec(2), duration: DEFAULT_FREEZE_TICKS }));
    const els = [...editor.tracks().main.elements].sort((a, b) => a.startTime - b.startTime);
    expect(els.map((e) => e.type)).toEqual(["video", "image", "video"]);
    expect(els[1]!.duration).toBe(2 * TICKS_PER_SECOND);
    editor.undo();
    expect(editor.tracks().main.elements).toHaveLength(1);
  });
});

describe("text animation controls logic", () => {
  const clip = (seconds: number): TextElement => text("t", 0, seconds);
  it("offers none plus every engine preset", () => {
    expect(ANIMATION_CHOICES.map((c) => c.id)).toEqual(["none", "fade", "slide-up", "pop", "typewriter", "blur-in", "stagger-words", "type-caret"]);
  });
  it("sets, changes and clears each side independently", () => {
    const { editor } = makeEditor();
    editor.execute(insertElement({ element: clip(4), placement: { mode: "auto" } }));
    const found = () => allElements(editor.tracks()).find((l) => l.element.id === "t")!;
    const ref = found().ref;
    const el = () => found().element as TextElement;
    editor.execute(textAnimationCommand({ ref, element: el(), side: "in", choice: "fade" }));
    editor.execute(textAnimationCommand({ ref, element: el(), side: "out", choice: "pop", duration: sec(1) }));
    expect(el().textAnimation).toEqual({ in: { preset: "fade", duration: sec(0.5) }, out: { preset: "pop", duration: sec(1) } });
    editor.execute(textAnimationCommand({ ref, element: el(), side: "in", choice: "none" }));
    expect(el().textAnimation).toEqual({ out: { preset: "pop", duration: sec(1) } });
    expect(sideState(el(), "in")).toMatchObject({ choice: "none", limit: sec(2) });
  });
  it("clamps a long request to half of the clip", () => {
    const { editor } = makeEditor();
    editor.execute(insertElement({ element: clip(2), placement: { mode: "auto" } }));
    const found = () => allElements(editor.tracks()).find((l) => l.element.id === "t")!;
    editor.execute(textAnimationCommand({ ref: found().ref, element: found().element as TextElement, side: "in", choice: "slide-up", duration: sec(9) }));
    expect((found().element as TextElement).textAnimation?.in?.duration).toBe(sec(1));
  });
});
