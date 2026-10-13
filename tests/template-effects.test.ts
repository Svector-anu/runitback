import { describe, expect, it } from "vitest";
import { currentScene } from "#/engine/commands";
import { PARAM, type ImageElement, type VideoElement } from "#/engine/model";
import { resolveElementParams, allElements } from "#/engine/timeline";
import { sec as secTicks } from "./helpers";
import { applyTemplateToEditor, parseTemplate, planTemplate, safeParseTemplate, type TemplateInputs } from "#/engine/templates";
import { assetOf, checkInvariants, editorWith, sampleTemplate, type AssetSpec } from "./template-support";

const SPECS: AssetSpec[] = [{ id: "v1", type: "video", seconds: 20 }, { id: "i1", type: "image" }];
const inputs: TemplateInputs = { slots: { "clip-a": "v1", "clip-b": "v1" } };
const raw = (): Record<string, unknown> => JSON.parse(JSON.stringify(sampleTemplate())) as Record<string, unknown>;

function withBeatMedia(patch: Record<string, unknown>): Record<string, unknown> {
  const t = raw() as { beats: Array<{ media?: Record<string, unknown> }> };
  t.beats[0]!.media = { ...t.beats[0]!.media, ...patch };
  return t;
}

describe("template schema: media styling", () => {
  const issues = (value: unknown): string[] => { const r = safeParseTemplate(value); return r.ok ? [] : r.issues.map((i) => `${i.path}: ${i.message}`); };

  it("accepts tilt, shadow, corners and auto zoom", () => {
    expect(issues(withBeatMedia({ tilt: { x: 10, y: -25, perspective: 1.5 }, shadow: {}, corners: 6 }))).toEqual([]);
    expect(issues(withBeatMedia({ shadow: { opacity: 30, blur: 80, offsetY: 30, offsetX: 4, color: "#112233" } }))).toEqual([]);
    expect(issues(withBeatMedia({ autoZoom: [{ at: 1, x: 300, y: -100 }, { at: 4, x: 0, y: 0, scale: 3, in: 0.5, hold: 1, out: 0.5 }] }))).toEqual([]);
  });
  it("rejects values outside their ranges with a path", () => {
    expect(issues(withBeatMedia({ tilt: { x: 120 } }))[0]).toMatch(/media\.tilt\.x/);
    expect(issues(withBeatMedia({ tilt: { perspective: 0.2 } }))[0]).toMatch(/perspective/);
    expect(issues(withBeatMedia({ shadow: { blur: 900 } }))[0]).toMatch(/shadow\.blur/);
    expect(issues(withBeatMedia({ shadow: { color: "red" } }))[0]).toMatch(/shadow\.color/);
    expect(issues(withBeatMedia({ corners: 80 }))[0]).toMatch(/corners/);
    expect(issues(withBeatMedia({ tilt: { z: 1 } }))[0]).toMatch(/not a template field/);
  });
  it("keeps zooms ordered, bounded and apart from pushIn", () => {
    expect(issues(withBeatMedia({ autoZoom: [] }))[0]).toMatch(/autoZoom/);
    expect(issues(withBeatMedia({ autoZoom: [{ at: 3, x: 0, y: 0 }, { at: 1, x: 0, y: 0 }] })).join()).toMatch(/time order/);
    expect(issues(withBeatMedia({ autoZoom: [{ at: 1, x: 0, y: 0, scale: 20 }] }))[0]).toMatch(/scale/);
    expect(issues(withBeatMedia({ autoZoom: Array.from({ length: 9 }, (_, i) => ({ at: i, x: 0, y: 0 })) }))[0]).toMatch(/at most 8/);
    expect(issues(withBeatMedia({ autoZoom: [{ at: 1, x: 0, y: 0 }], pushIn: 1.2 })).join()).toMatch(/one of them/);
  });
  it("refuses the visual keys on an audio slot", () => {
    const t = raw() as { beats: Array<{ id: string; media?: Record<string, unknown> }> };
    t.beats.find((b) => b.id === "m")!.media = { slot: "music", tilt: { x: 5 } };
    expect(issues(t).join()).toMatch(/audio/);
  });
});

describe("template schema: gradient canvas and cursor", () => {
  const issues = (value: unknown): string[] => { const r = safeParseTemplate(value); return r.ok ? [] : r.issues.map((i) => `${i.path}: ${i.message}`); };
  const withCanvas = (gradient: unknown): Record<string, unknown> => ({ ...raw(), canvas: { aspect: "16:9", fps: 30, gradient } });
  const withLayer = (layer: Record<string, unknown>): Record<string, unknown> => {
    const t = raw() as { beats: Array<{ layers?: unknown[] }> };
    t.beats[1]!.layers = [layer];
    return t;
  };

  it("accepts a gradient and rejects a bad one", () => {
    expect(issues(withCanvas({ style: "mesh", colors: ["#111111", "#7c3aed", "#06b6d4"], motion: 40 }))).toEqual([]);
    expect(issues(withCanvas({ style: "conic", colors: ["#111111", "#222222"] }))[0]).toMatch(/style/);
    expect(issues(withCanvas({ style: "linear", colors: ["#111111"] }))[0]).toMatch(/colors/);
    expect(issues(withCanvas({ style: "linear", colors: ["#111111", "blue"] }))[0]).toMatch(/colors\[1\]/);
    expect(issues(withCanvas({ style: "linear", colors: ["#111111", "#222222"], motion: 400 }))[0]).toMatch(/motion/);
  });
  it("accepts a cursor path on a cursor shape only, in time order", () => {
    const base = { kind: "graphic", shape: "cursor", box: { x: 0, y: 0, width: 400, height: 400 } };
    expect(issues(withLayer({ ...base, cursor: { path: [{ at: 0, x: 0, y: 0 }, { at: 1, x: 100, y: 50, click: true }] } }))).toEqual([]);
    expect(issues(withLayer({ ...base, cursor: { path: [{ at: 1, x: 0, y: 0 }, { at: 1, x: 5, y: 5 }] } })).join()).toMatch(/strictly increasing/);
    expect(issues(withLayer({ ...base, shape: "star", cursor: { path: [{ at: 0, x: 0, y: 0 }] } })).join()).toMatch(/only a cursor/);
    expect(issues(withLayer({ ...base, cursor: { path: [] } }))[0]).toMatch(/path/);
  });
  it("accepts the app frame and its parameters", () => {
    const layer = { kind: "graphic", shape: "app-frame", box: { x: 0, y: 0, width: 1200, height: 700 }, params: { style: "browser", fill: "#101010", cornerRadius: 16 } };
    expect(issues(withLayer(layer))).toEqual([]);
    expect(issues(withLayer({ ...layer, params: { style: "tablet" } }))[0]).toMatch(/style/);
  });
});

describe("applying media styling", () => {
  const build = (patch: Record<string, unknown>) => {
    const editor = editorWith(SPECS);
    const result = applyTemplateToEditor(editor, parseTemplate(withBeatMedia(patch)), inputs);
    const first = allElements(currentScene(editor.getState().doc).tracks).find((l) => l.element.startTime === 0 && (l.element.type === "video" || l.element.type === "image"))!.element as VideoElement | ImageElement;
    return { editor, result, first };
  };

  it("writes tilt params, a shadow effect and a rounded mask in the one undo step", () => {
    const { editor, first } = build({ tilt: { x: 12, y: -30, perspective: 1.8 }, shadow: { blur: 70, offsetY: 28 }, corners: 6 });
    expect(first.params).toMatchObject({ [PARAM.rotateX]: 12, [PARAM.rotateY]: -30, [PARAM.perspective]: 1.8 });
    expect(first.effects?.map((e) => e.type)).toContain("shadow");
    expect(first.effects?.find((e) => e.type === "shadow")?.params).toMatchObject({ blur: 70, offsetY: 28, opacity: 40 });
    expect(first.masks?.[0]).toMatchObject({ type: "rectangle", params: { width: 1, height: 1, cornerRadius: 6 } });
    checkInvariants(editor);
    expect(editor.undo()).toBe(true);
    expect(editor.getState().canUndo).toBe(false);
  });
  it("does nothing extra without the keys", () => {
    const { first } = build({});
    expect(first.params[PARAM.rotateY]).toBeUndefined();
    expect(first.masks).toBeUndefined();
    expect(first.effects?.some((e) => e.type === "shadow") ?? false).toBe(false);
  });
  it("animates auto zooms from the clip start, and skips ones that do not fit with a warning", () => {
    const { first, result } = build({ autoZoom: [{ at: 1, x: 300, y: -100, scale: 2, in: 0.5, hold: 1, out: 0.5 }, { at: 4.8, x: 0, y: 0, scale: 2, hold: 2 }] });
    expect(resolveElementParams(first, secTicks(2))[PARAM.scaleX]).toBeCloseTo(2 * (first.params[PARAM.scaleX] as number), 2);
    expect(resolveElementParams(first, secTicks(3.5))[PARAM.scaleX]).toBeCloseTo(first.params[PARAM.scaleX] as number, 2);
    expect(result.warnings.some((w) => w.code === "zoom-skipped")).toBe(true);
  });
  it("sets a gradient background, which wins over the colour", () => {
    const editor = editorWith(SPECS);
    const t = parseTemplate({ ...raw(), canvas: { aspect: "16:9", fps: 30, backgroundColor: "#101322", gradient: { style: "mesh", colors: ["#111111", "#7c3aed"], motion: 30 } } });
    applyTemplateToEditor(editor, t, inputs);
    expect(editor.getState().doc.settings.background).toEqual({ type: "gradient", style: "mesh", colors: ["#111111", "#7c3aed"], angle: 135, motion: 30 });
    expect(planTemplate({ template: t, inputs, assets: [assetOf(SPECS[0]!)] }).gradient?.style).toBe("mesh");
  });
});

describe("applying a cursor layer", () => {
  it("moves the cursor along its path and plays the click", () => {
    const t = raw() as { beats: Array<{ layers?: unknown[] }> };
    t.beats[1]!.layers = [{
      kind: "graphic", shape: "cursor", at: 0, duration: 4, box: { x: -300, y: 100, width: 460, height: 460 },
      cursor: { path: [{ at: 0, x: -300, y: 100 }, { at: 1.5, x: 200, y: -50, click: true }, { at: 3, x: 200, y: -50 }] },
    }];
    const editor = editorWith(SPECS);
    const result = applyTemplateToEditor(editor, parseTemplate(t), inputs);
    expect(result.warnings.filter((w) => w.code === "cursor-skipped")).toEqual([]);
    const cursor = allElements(currentScene(editor.getState().doc).tracks).find((l) => l.element.type === "graphic" && l.element.definitionId === "cursor")!.element;
    const at = (s: number) => resolveElementParams(cursor, secTicks(s));
    expect(at(0)[PARAM.positionX]).toBe(-300);
    expect(at(1.5)[PARAM.positionX]).toBe(200);
    expect(at(1.75).click).toBeGreaterThan(0);
    expect(at(1.75).click).toBeLessThan(1);
  });
  it("drops a path that does not fit the layer, with a warning, and still draws the cursor", () => {
    const t = raw() as { beats: Array<{ layers?: unknown[] }> };
    t.beats[1]!.layers = [{ kind: "graphic", shape: "cursor", at: 0, duration: 1, box: { x: 0, y: 0, width: 400, height: 400 }, cursor: { path: [{ at: 0, x: 0, y: 0 }, { at: 0.5, x: 5, y: 5 }, { at: 0.5001, x: 9, y: 9 }] } }];
    const editor = editorWith(SPECS);
    const result = applyTemplateToEditor(editor, parseTemplate(t), inputs);
    expect(result.warnings.some((w) => w.code === "cursor-skipped")).toBe(true);
    expect(allElements(currentScene(editor.getState().doc).tracks).some((l) => l.element.type === "graphic")).toBe(true);
  });
});

describe("count-up in a template text", () => {
  const textTemplate = () => parseTemplate({
    ...raw(),
    texts: [{ id: "title", label: "Title", default: "$12,400", style: "headline", animation: { in: { preset: "count-up", seconds: 1 } } }],
  });
  it("counts up the default number and skips the animation, with a warning, when the user's words have none", () => {
    const editor = editorWith(SPECS);
    const result = applyTemplateToEditor(editor, textTemplate(), inputs);
    const text = allElements(currentScene(editor.getState().doc).tracks).find((l) => l.element.type === "text")!.element;
    expect(text.params).toMatchObject({ countEnabled: true, countValue: 12400 });
    expect(result.warnings.filter((w) => w.code === "count-skipped")).toEqual([]);

    const words = editorWith(SPECS);
    const typed = applyTemplateToEditor(words, textTemplate(), { ...inputs, texts: { title: "Lots of users" } });
    const plain = allElements(currentScene(words.getState().doc).tracks).find((l) => l.element.type === "text")!.element;
    expect(plain.params[PARAM.countEnabled]).toBeUndefined();
    expect(typed.warnings.some((w) => w.code === "count-skipped")).toBe(true);
  });
});

describe("graphic layers with shadow and zoom", () => {
  it("a frame and the clip inside it zoom together and the frame casts a shadow", () => {
    const stops = [{ at: 1, x: 300, y: -100, scale: 2, in: 0.5, hold: 1, out: 0.5 }];
    const t = raw() as { beats: Array<{ layers?: unknown[]; media?: Record<string, unknown> }> };
    t.beats[0]!.media = { slot: "clip-a", box: { x: 0, y: 30, width: 1400, height: 760 }, track: "overlay", fit: "cover", autoZoom: stops };
    t.beats[0]!.layers = [{ kind: "graphic", shape: "app-frame", at: 0, box: { x: 0, y: 0, width: 1500, height: 840 }, params: { style: "browser" }, shadow: { blur: 90 }, autoZoom: stops }];
    const editor = editorWith(SPECS);
    const result = applyTemplateToEditor(editor, parseTemplate(t), inputs);
    expect(result.warnings.filter((w) => w.code === "zoom-skipped")).toEqual([]);
    const elements = allElements(currentScene(editor.getState().doc).tracks).map((l) => l.element);
    const frame = elements.find((e) => e.type === "graphic")!;
    const clip = elements.find((e) => e.type === "video" && e.startTime === 0)!;
    expect(frame.type === "graphic" && frame.effects?.[0]).toMatchObject({ type: "shadow", params: { blur: 90 } });
    const ratio = (el: typeof frame, s: number) => (resolveElementParams(el, secTicks(s))[PARAM.scaleX] as number) / (resolveElementParams(el, secTicks(0))[PARAM.scaleX] as number);
    expect(ratio(frame, 2)).toBeCloseTo(2, 2);
    expect(ratio(clip, 2)).toBeCloseTo(2, 2);
    expect(resolveElementParams(frame, secTicks(1.75))[PARAM.positionX]).toBeCloseTo(resolveElementParams(clip, secTicks(1.75))[PARAM.positionX] as number, 0);
  });
});
