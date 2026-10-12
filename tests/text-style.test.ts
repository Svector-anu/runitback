import { describe, expect, it } from "vitest";
import { insertElement, setTextAnimationCommand, splitCommand } from "#/engine/commands";
import { textAnimationKeys, maxTextAnimationDuration } from "#/engine/animation";
import { PARAM, TEXT_DEFAULTS, type TextElement } from "#/engine/model";
import { resolveElementParams, allElements } from "#/engine/timeline";
import { deserializeProject, serializeProject } from "#/engine/persistence";
import type { Editor } from "#/engine/editor";
import { drawTextLayout, layoutText, visibleCounts } from "#/render/text";
import { setupAgent } from "./agent-harness";
import { makeEditor, sec, text } from "./helpers";

function textEditor(seconds = 6): { editor: Editor; ref: { trackId: string; elementId: string } } {
  const { editor } = makeEditor();
  editor.execute(insertElement({ element: text("t", 0, seconds), placement: { mode: "newTrack", index: 0, trackId: "txt" } }));
  return { editor, ref: { trackId: "txt", elementId: "t" } };
}
const textOf = (editor: Editor): TextElement => allElements(editor.tracks()).find((l) => l.element.id === "t")?.element as TextElement;

type Call = [string, ...unknown[]];
function recordingContext(): { ctx: CanvasRenderingContext2D; calls: Call[] } {
  const calls: Call[] = [];
  const state: Record<string, unknown> = {};
  const ctx = new Proxy({}, {
    get(_t, prop: string) {
      if (prop === "getTransform") return () => ({ a: 1, b: 0, c: 0, d: 1 });
      if (prop === "measureText") return (s: string) => ({ width: s.length * 10 });
      if (["fillText", "strokeText", "fillRect", "rect", "roundRect", "beginPath", "fill"].includes(prop)) return (...args: unknown[]) => { calls.push([prop, ...args, { shadow: state.shadowColor, blur: state.shadowBlur, width: state.lineWidth, align: state.textAlign }]); };
      return state[prop];
    },
    set(_t, prop: string, value) { state[prop] = value; return true; },
  }) as unknown as CanvasRenderingContext2D;
  return { ctx, calls };
}
const measure = (line: string): number => line.length * 10;

describe("text stroke, shadow and reveal rendering", () => {
  it("draws the stroke first at twice the visible width, then the fill without a second shadow", () => {
    const { ctx, calls } = recordingContext();
    const params = { ...TEXT_DEFAULTS, content: "Hi", [PARAM.strokeWidth]: 3, [PARAM.strokeColor]: "#ff0000", [PARAM.shadowEnabled]: true, [PARAM.shadowBlur]: 6, [PARAM.shadowColor]: "#112233" };
    drawTextLayout(ctx, layoutText({ params, canvasHeight: 90, measure }), params);
    const names = calls.map((c) => c[0]);
    expect(names.indexOf("strokeText")).toBeLessThan(names.indexOf("fillText"));
    const stroke = calls.find((c) => c[0] === "strokeText")!;
    expect((stroke[stroke.length - 1] as { width: number; shadow: string }).width).toBe(6);
    expect((stroke[stroke.length - 1] as { shadow: string }).shadow).toBe("#112233");
    const fill = calls.find((c) => c[0] === "fillText")!;
    expect((fill[fill.length - 1] as { shadow: string }).shadow).toBe("rgba(0,0,0,0)");
  });
  it("without a stroke the shadow sits on the fill, and by default nothing extra is drawn", () => {
    const shadowed = recordingContext();
    const params = { ...TEXT_DEFAULTS, content: "Hi", [PARAM.shadowEnabled]: true };
    drawTextLayout(shadowed.ctx, layoutText({ params, canvasHeight: 90, measure }), params);
    expect(shadowed.calls.some((c) => c[0] === "strokeText")).toBe(false);
    expect((shadowed.calls.find((c) => c[0] === "fillText")!.at(-1) as { shadow: string }).shadow).toBe("#000000b3");
    const plain = recordingContext();
    const defaults = { ...TEXT_DEFAULTS, content: "Hi" };
    drawTextLayout(plain.ctx, layoutText({ params: defaults, canvasHeight: 90, measure }), defaults);
    expect(plain.calls.map((c) => c[0])).toEqual(["fillText"]);
  });
  it("typewriter reveals characters across lines and keeps the finished position", () => {
    expect(visibleCounts(["abcd", "ef"], 0)).toEqual([0, 0]);
    expect(visibleCounts(["abcd", "ef"], 0.5)).toEqual([3, 0]);
    expect(visibleCounts(["abcd", "ef"], 0.84)).toEqual([4, 1]);
    expect(visibleCounts(["abcd", "ef"], 1)).toEqual([4, 2]);
    const { ctx, calls } = recordingContext();
    const params = { ...TEXT_DEFAULTS, content: "abcd", [PARAM.reveal]: 0.5 };
    drawTextLayout(ctx, layoutText({ params, canvasHeight: 90, measure }), params);
    const fill = calls.find((c) => c[0] === "fillText")!;
    expect(fill[1]).toBe("ab");
    expect(fill[2]).toBe(-20);
    expect((fill.at(-1) as { align: string }).align).toBe("left");
  });
});

describe("text animation presets", () => {
  const input = (state: Parameters<typeof textAnimationKeys>[0]["state"], clip = sec(6)) =>
    textAnimationKeys({ state, clipDuration: clip, params: { ...TEXT_DEFAULTS, opacity: 0.8 }, canvasHeight: 1000 });
  it("fade in ends at the clip's own opacity", () => {
    expect(input({ in: { preset: "fade", duration: sec(1) } })[PARAM.opacity]).toEqual([{ time: 0, value: 0 }, { time: sec(1), value: 0.8 }]);
  });
  it("slide-up starts below and rises to the base position while fading", () => {
    const keys = input({ in: { preset: "slide-up", duration: sec(1) } });
    expect(keys[PARAM.positionY]).toEqual([{ time: 0, value: 80 }, { time: sec(1), value: 0 }]);
  });
  it("pop overshoots then settles; typewriter animates reveal", () => {
    const pop = input({ in: { preset: "pop", duration: sec(1) } })[PARAM.scaleX]!;
    expect(pop.map((k) => k.value)).toEqual([0.5, 1.1, 1]);
    expect(input({ out: { preset: "typewriter", duration: sec(2) } })[PARAM.reveal]).toEqual([{ time: sec(4), value: 1 }, { time: sec(6), value: 0 }]);
  });
  it("in and out merge on the same path in time order and clamp to half the clip", () => {
    const keys = input({ in: { preset: "fade", duration: sec(5) }, out: { preset: "fade", duration: sec(5) } });
    expect(keys[PARAM.opacity]!.map((k) => k.time)).toEqual([0, sec(3), sec(3), sec(6)]);
    expect(maxTextAnimationDuration(sec(6))).toBe(sec(3));
  });
});

describe("setTextAnimationCommand", () => {
  it("writes keyframes the frame plan resolves, in one undo step, and a later side keeps the earlier one", () => {
    const { editor, ref } = textEditor();
    editor.execute(setTextAnimationCommand({ ref, in: { preset: "fade", duration: sec(1) as never } }));
    editor.execute(setTextAnimationCommand({ ref, out: { preset: "typewriter", duration: sec(1) as never } }));
    const el = textOf(editor);
    expect(el.textAnimation?.in?.preset).toBe("fade");
    expect(el.textAnimation?.out?.preset).toBe("typewriter");
    expect(resolveElementParams(el, 0)[PARAM.opacity]).toBe(0);
    expect(resolveElementParams(el, sec(2))[PARAM.opacity]).toBe(1);
    expect(resolveElementParams(el, sec(2))[PARAM.reveal]).toBe(1);
    expect(resolveElementParams(el, sec(5.5))[PARAM.reveal]).toBeCloseTo(0.5, 2);
    editor.undo();
    expect(textOf(editor).textAnimation?.out).toBeUndefined();
    editor.execute(setTextAnimationCommand({ ref, in: null }));
    expect(textOf(editor).textAnimation).toBeUndefined();
    expect(textOf(editor).animations?.[PARAM.opacity]).toBeUndefined();
  });
  it("leaves keyframes on other parameters alone, rejects non-text and unknown presets, and does not survive a split", () => {
    const { editor, ref } = textEditor();
    editor.execute(setTextAnimationCommand({ ref, in: { preset: "pop", duration: sec(1) as never } }));
    editor.execute(splitCommand({ refs: [ref], splitTime: sec(3) }));
    expect(allElements(editor.tracks()).every((l) => (l.element as TextElement).textAnimation === undefined)).toBe(true);
    expect(() => editor.execute(setTextAnimationCommand({ ref, in: { preset: "spin" as never, duration: sec(1) as never } }))).toThrow(/Unknown text animation/);
  });
  it("persists and repairs", () => {
    const { editor, ref } = textEditor();
    editor.execute(setTextAnimationCommand({ ref, in: { preset: "fade", duration: sec(1) as never } }));
    const json = JSON.parse(serializeProject(editor.toProject())) as { scenes: Array<{ tracks: { overlay: Array<{ elements: Array<{ textAnimation?: unknown }> }> } }> };
    expect(deserializeProject(json).scenes[0]?.tracks.overlay[0]?.elements[0]).toMatchObject({ textAnimation: { in: { preset: "fade" } } });
    json.scenes[0]!.tracks.overlay[0]!.elements[0]!.textAnimation = { in: { preset: "wiggle", duration: 5 } };
    const repaired = deserializeProject(json);
    expect((repaired.scenes[0]?.tracks.overlay[0]?.elements[0] as TextElement).textAnimation).toBeUndefined();
    expect(repaired.repairNotes?.some((n) => /text animation/.test(n))).toBe(true);
  });
});

describe("agent text tools", () => {
  async function withTitle() {
    const h = setupAgent();
    const { elementId } = await h.data<{ elementId: string }>("insert_text", { text: "Hello", start: 0, duration: 6 });
    return { h, id: elementId };
  }
  const paramsOf = (h: ReturnType<typeof setupAgent>, id: string) => allElements(h.editor.tracks()).find((l) => l.element.id === id)!.element.params;
  it("set_text_style sets stroke, shadow and background in one undo step", async () => {
    const { h, id } = await withTitle();
    await h.data("set_text_style", { elementIds: [id], color: "#ffcc00", stroke: { width: 4, color: "#000000" }, shadow: { blur: 10, offsetX: 6 }, background: { color: "#223344", cornerRadius: 40 } });
    expect(paramsOf(h, id)).toMatchObject({ color: "#ffcc00", "stroke.width": 4, "shadow.enabled": true, "shadow.blur": 10, "shadow.offsetX": 6, "background.enabled": true, "background.cornerRadius": 40 });
    h.editor.undo();
    expect(paramsOf(h, id)).toMatchObject({ "stroke.width": 0, "shadow.enabled": false });
    await h.data("set_text_style", { elementIds: [id], shadow: { enabled: false } });
    expect(paramsOf(h, id)["shadow.enabled"]).toBe(false);
  });
  it("set_text_style explains bad keys and non-text clips", async () => {
    const { h, id } = await withTitle();
    expect((await h.failure("set_text_style", { elementIds: [id], stroke: { thickness: 3 } })).hint).toContain("width");
    expect((await h.failure("set_text_style", { elementIds: [id], stroke: { width: 900 } })).error).toContain("maximum");
    await h.data("insert_media", { assetId: "a1", start: 0 });
    const tl = await h.data<{ tracks: Array<{ elements: Array<{ id: string; type: string }> }> }>("get_timeline");
    const videoId = tl.tracks.flatMap((t) => t.elements).find((e) => e.type === "video")!.id;
    expect((await h.failure("set_text_style", { elementIds: [videoId], color: "#ffffff" })).error).toContain("not text");
  });
  it("set_text_animation applies presets, reports them, and clears with none", async () => {
    const { h, id } = await withTitle();
    const out = await h.data<{ clips: Array<{ in: { preset: string; duration: number }; out: unknown }> }>("set_text_animation", { elementIds: [id], in: { preset: "pop", duration: 0.6 }, out: { preset: "fade" } });
    expect(out.clips[0]?.in).toEqual({ preset: "pop", duration: 0.6 });
    expect(out.clips[0]?.out).toEqual({ preset: "fade", duration: 0.5 });
    await h.data("set_text_animation", { elementIds: [id], in: { preset: "none" } });
    expect((allElements(h.editor.tracks()).find((l) => l.element.id === id)!.element as TextElement).textAnimation?.in).toBeUndefined();
    expect((await h.failure("set_text_animation", { elementIds: [id] })).error).toContain("Nothing");
  });
});
