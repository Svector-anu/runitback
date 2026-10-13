import { describe, expect, it } from "vitest";
import { textAnimationKeys } from "#/engine/animation";
import { insertElement, setTextAnimationCommand } from "#/engine/commands";
import { PARAM, TEXT_DEFAULTS, type TextElement } from "#/engine/model";
import {
  buildFramePlan, caretVisible, isWordHighlighted, staggerWordProgress, wordCounts, wordSpans, type TextLayer,
} from "#/engine/render";
import { allElements, resolveElementParams } from "#/engine/timeline";
import { drawTextLayout, layoutText } from "#/render/text";
import { setupAgent } from "./agent-harness";
import { makeEditor, sec, text, tracksWith } from "./helpers";

type Call = [string, ...unknown[]];
function recordingContext(): { ctx: CanvasRenderingContext2D; calls: Call[] } {
  const calls: Call[] = [];
  const state: Record<string, unknown> = { globalAlpha: 1 };
  const ctx = new Proxy({}, {
    get(_t, prop: string) {
      if (prop === "getTransform") return () => ({ a: 1, b: 0, c: 0, d: 1 });
      if (prop === "measureText") return (s: string) => ({ width: s.length * 10 });
      if (["fillText", "strokeText", "fillRect", "rect", "roundRect", "beginPath", "fill"].includes(prop)) {
        return (...args: unknown[]) => { calls.push([prop, ...args, { fill: state.fillStyle, alpha: state.globalAlpha }]); };
      }
      return state[prop];
    },
    set(_t, prop: string, value) { state[prop] = value; return true; },
  }) as unknown as CanvasRenderingContext2D;
  return { ctx, calls };
}
const measure = (line: string): number => line.length * 10;
const meta = (call: Call): { fill: string; alpha: number } => call.at(-1) as { fill: string; alpha: number };
const draw = (params: Record<string, number | string | boolean>, seconds = 0): Call[] => {
  const { ctx, calls } = recordingContext();
  const merged = { ...TEXT_DEFAULTS, ...params };
  drawTextLayout(ctx, layoutText({ params: merged, canvasHeight: 90, measure }), merged, seconds);
  return calls;
};

describe("word maths", () => {
  it("splits lines into words and indexes them across lines", () => {
    expect(wordSpans({ line: "  ab  cde f", firstIndex: 3 })).toEqual([{ index: 3, start: 2, end: 4 }, { index: 4, start: 6, end: 9 }, { index: 5, start: 10, end: 11 }]);
    expect(wordCounts(["one two", "", "three"])).toEqual([2, 0, 1]);
  });
  it("stagger starts at nothing, finishes everything at 1, and words enter in order", () => {
    const at = (index: number, progress: number): number => staggerWordProgress({ index, count: 4, progress });
    for (let i = 0; i < 4; i++) { expect(at(i, 0)).toBe(0); expect(at(i, 1)).toBe(1); }
    for (const progress of [0.2, 0.5, 0.7]) for (let i = 0; i < 3; i++) expect(at(i, progress)).toBeGreaterThanOrEqual(at(i + 1, progress));
    expect(at(0, 0.3)).toBeGreaterThan(0);
    expect(at(3, 0.3)).toBe(0);
    expect(staggerWordProgress({ index: 0, count: 0, progress: 0 })).toBe(1);
  });
  it("highlights one word, or every word up to it when sweeping", () => {
    expect(isWordHighlighted({ index: 2, highlightWord: -1, sweep: false })).toBe(false);
    expect(isWordHighlighted({ index: 1, highlightWord: 2, sweep: false })).toBe(false);
    expect(isWordHighlighted({ index: 2, highlightWord: 2, sweep: false })).toBe(true);
    expect(isWordHighlighted({ index: 1, highlightWord: 2, sweep: true })).toBe(true);
    expect(isWordHighlighted({ index: 3, highlightWord: 2, sweep: true })).toBe(false);
  });
  it("the caret is solid while typing and blinks afterwards", () => {
    expect(caretVisible({ typing: true, seconds: 0.75 })).toBe(true);
    expect(caretVisible({ typing: false, seconds: 0.25 })).toBe(true);
    expect(caretVisible({ typing: false, seconds: 0.75 })).toBe(false);
    expect(caretVisible({ typing: false, seconds: 1.25 })).toBe(true);
    expect(caretVisible({ typing: false, seconds: -0.25 })).toBe(false);
  });
});

describe("word-wise text drawing", () => {
  it("draws nothing extra by default", () => {
    expect(draw({ content: "Hello world" }).map((c) => c[0])).toEqual(["fillText"]);
  });
  it("staggers words: later words are fainter and absent at progress 0", () => {
    expect(draw({ content: "a b c", [PARAM.wordReveal]: 0 })).toHaveLength(0);
    const calls = draw({ content: "a b c", [PARAM.wordReveal]: 0.5 }).filter((c) => c[0] === "fillText");
    const alphas = calls.map((c) => meta(c).alpha);
    expect(calls.map((c) => c[1])).toEqual(["a", "b"]);
    expect(alphas[0]).toBeGreaterThan(alphas[1] as number);
    expect(draw({ content: "a b c", [PARAM.wordReveal]: 1 }).map((c) => c[1])).toEqual(["a b c"]);
  });
  it("places each word where the finished line puts it", () => {
    const calls = draw({ content: "aa bbb", [PARAM.highlightWord]: 1 }).filter((c) => c[0] === "fillText");
    expect(calls.map((c) => c[1])).toEqual(["aa", "bbb"]);
    expect(calls[0]?.[2]).toBe(-30);
    expect(calls[1]?.[2]).toBe(-30 + 30);
  });
  it("colours the highlighted word, or all words up to it when sweeping", () => {
    const only = draw({ content: "a b c", [PARAM.highlightWord]: 1, [PARAM.highlightColor]: "#ff0000" }).filter((c) => c[0] === "fillText");
    expect(only.map((c) => meta(c).fill)).toEqual(["#ffffff", "#ff0000", "#ffffff"]);
    const sweep = draw({ content: "a b c", [PARAM.highlightWord]: 1, [PARAM.highlightColor]: "#ff0000", [PARAM.highlightSweep]: true }).filter((c) => c[0] === "fillText");
    expect(sweep.map((c) => meta(c).fill)).toEqual(["#ff0000", "#ff0000", "#ffffff"]);
  });
  it("counts highlight indexes across lines", () => {
    const calls = draw({ content: "a b\nc d", [PARAM.highlightWord]: 2, [PARAM.highlightColor]: "#00ff00" }).filter((c) => c[0] === "fillText");
    expect(calls.map((c) => [c[1], meta(c).fill])).toEqual([["a", "#ffffff"], ["b", "#ffffff"], ["c", "#00ff00"], ["d", "#ffffff"]]);
  });
  it("draws the caret after the typed characters, solid while typing and blinking when complete", () => {
    const rects = (params: Record<string, number | string | boolean>, seconds: number): Call[] => draw({ content: "abcd", [PARAM.caret]: true, ...params }, seconds).filter((c) => c[0] === "fillRect");
    const typing = rects({ [PARAM.reveal]: 0.5 }, 0.75);
    expect(typing).toHaveLength(1);
    expect((typing[0]?.[1] as number)).toBeCloseTo(-20 + 20 + 0.04 * 6 * 1, 0);
    expect(rects({}, 0.25)).toHaveLength(1);
    expect(rects({}, 0.75)).toHaveLength(0);
    expect(draw({ content: "abcd" }, 0.25).filter((c) => c[0] === "fillRect")).toHaveLength(0);
    expect(rects({ [PARAM.reveal]: 0 }, 0.75)).toHaveLength(1);
  });
});

describe("text blur in the frame plan", () => {
  it("adds a blur effect and the clip time to the text layer", () => {
    const base = text("t", 0, 4);
    const tracks = tracksWith({ overlay: [{ id: "x", type: "text", elements: [{ ...base, params: { ...base.params, [PARAM.blur]: 30 } }] }] });
    const layer = buildFramePlan({ tracks, canvas: { width: 1920, height: 1080 }, background: { type: "color", color: "#000" }, assets: [], time: sec(1.5) }).items[0] as TextLayer;
    expect(layer.effects).toEqual([{ type: "blur", params: { intensity: 30 } }]);
    expect(layer.seconds).toBeCloseTo(1.5, 5);
  });
  it("leaves sharp text alone", () => {
    const tracks = tracksWith({ overlay: [{ id: "x", type: "text", elements: [text("t", 0, 4)] }] });
    const layer = buildFramePlan({ tracks, canvas: { width: 1920, height: 1080 }, background: { type: "color", color: "#000" }, assets: [], time: 0 }).items[0] as TextLayer;
    expect(layer.effects).toEqual([]);
  });
});

describe("new text animation presets", () => {
  const keys = (state: Parameters<typeof textAnimationKeys>[0]["state"], params = {}) =>
    textAnimationKeys({ state, clipDuration: sec(6), params: { ...TEXT_DEFAULTS, ...params }, canvasHeight: 1000 });
  it("blur-in sharpens to the clip's own blur while fading in and rising a little", () => {
    const k = keys({ in: { preset: "blur-in", duration: sec(1) } }, { blur: 5 });
    expect(k[PARAM.blur]).toEqual([{ time: 0, value: 40 }, { time: sec(1), value: 5 }]);
    expect(k[PARAM.opacity]?.[0]).toEqual({ time: 0, value: 0 });
    expect(k[PARAM.positionY]?.[0]?.value).toBeGreaterThan(0);
    expect(k[PARAM.positionY]?.[1]?.value).toBe(0);
  });
  it("blur-in on the way out blurs away and fades", () => {
    const k = keys({ out: { preset: "blur-in", duration: sec(1) } });
    expect(k[PARAM.blur]).toEqual([{ time: sec(5), value: 0 }, { time: sec(6), value: 40 }]);
    expect(k[PARAM.opacity]?.at(-1)).toEqual({ time: sec(6), value: 0 });
  });
  it("stagger-words animates wordReveal; type-caret animates reveal", () => {
    expect(keys({ in: { preset: "stagger-words", duration: sec(2) } })[PARAM.wordReveal]).toEqual([{ time: 0, value: 0 }, { time: sec(2), value: 1 }]);
    expect(keys({ in: { preset: "type-caret", duration: sec(2) } })[PARAM.reveal]).toEqual([{ time: 0, value: 0 }, { time: sec(2), value: 1 }]);
  });
});

describe("setTextAnimationCommand with the new presets", () => {
  const setup = () => {
    const { editor } = makeEditor();
    editor.execute(insertElement({ element: text("t", 0, 6), placement: { mode: "newTrack", index: 0, trackId: "txt" } }));
    return { editor, ref: { trackId: "txt", elementId: "t" } };
  };
  const textOf = (editor: ReturnType<typeof setup>["editor"]): TextElement => allElements(editor.tracks()).find((l) => l.element.id === "t")?.element as TextElement;
  it("type-caret turns the caret on in the same undo step", () => {
    const { editor, ref } = setup();
    editor.execute(setTextAnimationCommand({ ref, in: { preset: "type-caret", duration: sec(1) as never } }));
    expect(textOf(editor).params[PARAM.caret]).toBe(true);
    expect(resolveElementParams(textOf(editor), sec(0.5))[PARAM.reveal]).toBeCloseTo(0.5, 2);
    editor.undo();
    expect(textOf(editor).params[PARAM.caret]).toBeUndefined();
  });
  it("blur-in writes blur keyframes the plan resolves", () => {
    const { editor, ref } = setup();
    editor.execute(setTextAnimationCommand({ ref, in: { preset: "blur-in", duration: sec(1) as never } }));
    expect(resolveElementParams(textOf(editor), 0)[PARAM.blur]).toBe(40);
    expect(resolveElementParams(textOf(editor), sec(2))[PARAM.blur]).toBe(0);
    editor.execute(setTextAnimationCommand({ ref, in: null }));
    expect(textOf(editor).animations?.[PARAM.blur]).toBeUndefined();
  });
});

describe("agent access", () => {
  it("set_text_animation accepts the new presets and set_params reaches the new text keys", async () => {
    const h = setupAgent();
    const { elementId } = await h.data<{ elementId: string }>("insert_text", { text: "Ship faster today", start: 0, duration: 6 });
    const out = await h.data<{ clips: Array<{ in: { preset: string } }> }>("set_text_animation", { elementIds: [elementId], in: { preset: "stagger-words", duration: 1 } });
    expect(out.clips[0]?.in.preset).toBe("stagger-words");
    await h.data("set_params", { elementIds: [elementId], params: { blur: 12, highlightWord: 1, highlightColor: "#ff8800", caret: true } });
    const params = allElements(h.editor.tracks()).find((l) => l.element.id === elementId)!.element.params;
    expect(params).toMatchObject({ blur: 12, highlightWord: 1, highlightColor: "#ff8800", caret: true });
    expect((await h.failure("set_params", { elementIds: [elementId], params: { blur: 400 } })).error).toContain("maximum");
  });
});
