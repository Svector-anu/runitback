import { describe, expect, it } from "vitest";
import { AUTO_ZOOM_PATHS, autoZoomAnimations, autoZoomProblem, zoomedFraming, type AutoZoom } from "#/engine/animation";
import { autoZoomCommand, insertElement } from "#/engine/commands";
import { PARAM, type ImageElement, type VideoElement } from "#/engine/model";
import { TICKS_PER_SECOND } from "#/engine/time";
import { allElements, resolveElementParams } from "#/engine/timeline";
import { zoomAtPlayhead } from "#/app/zoom-pick";
import { setupAgent } from "./agent-harness";
import { image, makeEditor, sec, text, video, ids } from "./helpers";

const zoom = (extra: Partial<AutoZoom> = {}): AutoZoom => ({ at: sec(1), x: 300, y: -100, scale: 2, inTicks: sec(0.5), holdTicks: sec(1), outTicks: sec(0.5), ...extra });
const base = { [PARAM.scaleX]: 1, [PARAM.scaleY]: 1, [PARAM.positionX]: 0, [PARAM.positionY]: 0 };

describe("zoomedFraming", () => {
  it("puts the chosen screen point at the centre of the frame, k times bigger", () => {
    const f = zoomedFraming({ from: { scaleX: 1, scaleY: 1, x: 0, y: 0 }, px: 300, py: -100, k: 2 });
    expect(f).toEqual({ scaleX: 2, scaleY: 2, x: -600, y: 200 });
    const pointAfter = { x: f.x + 2 * 300, y: f.y + 2 * -100 };
    expect(pointAfter).toEqual({ x: 0, y: 0 });
  });
  it("respects a clip that is already scaled and moved", () => {
    const from = { scaleX: 0.5, scaleY: 0.5, x: 100, y: 40 };
    const f = zoomedFraming({ from, px: 160, py: 60, k: 3 });
    const local = { x: (160 - from.x) / from.scaleX, y: (60 - from.y) / from.scaleY };
    expect(f.x + f.scaleX * local.x).toBeCloseTo(0, 9);
    expect(f.y + f.scaleY * local.y).toBeCloseTo(0, 9);
  });
});

describe("autoZoomAnimations", () => {
  const animated = (zooms: AutoZoom[], params = base) => ({ animations: autoZoomAnimations({ animations: undefined, params, zooms, newId: ids }), params }) as unknown as VideoElement;
  const at = (el: VideoElement, seconds: number) => resolveElementParams(el, sec(seconds));

  it("rests, eases in, holds, eases back to the starting framing", () => {
    const el = animated([zoom()]);
    const framing = (seconds: number) => [PARAM.scaleX, PARAM.scaleY, PARAM.positionX, PARAM.positionY].map((key) => at(el, seconds)[key] as number);
    const expectFraming = (seconds: number, expected: number[]): void => framing(seconds).forEach((v, i) => expect(v).toBeCloseTo(expected[i] as number, 3));
    expectFraming(0, [1, 1, 0, 0]);
    expectFraming(1, [1, 1, 0, 0]);
    expectFraming(1.5, [2, 2, -600, 200]);
    expectFraming(2.5, [2, 2, -600, 200]);
    expectFraming(3, [1, 1, 0, 0]);
    expectFraming(5, [1, 1, 0, 0]);
    const mid = at(el, 1.25)[PARAM.scaleX] as number;
    expect(mid).toBeGreaterThan(1);
    expect(mid).toBeLessThan(2);
  });
  it("never leaves the range between the two framings", () => {
    const el = animated([zoom()]);
    for (let s = 0; s <= 4; s += 0.05) {
      const scale = at(el, s)[PARAM.scaleX] as number;
      expect(scale).toBeGreaterThanOrEqual(1 - 1e-9);
      expect(scale).toBeLessThanOrEqual(2 + 1e-9);
    }
  });
  it("with no ease-back stays zoomed, and the next zoom starts from there", () => {
    const el = animated([zoom({ outTicks: 0 }), zoom({ at: sec(3), x: 0, y: 0, scale: 2, outTicks: sec(0.5) })]);
    expect(at(el, 2.9)[PARAM.scaleX]).toBeCloseTo(2, 3);
    expect(at(el, 3.5)[PARAM.scaleX]).toBeCloseTo(4, 3);
    expect(at(el, 5)[PARAM.scaleX]).toBeCloseTo(1, 3);
  });
  it("replaces earlier keyframes on scale and position only", () => {
    const first = autoZoomAnimations({ animations: { opacity: { kind: "channel", channel: { kind: "scalar", keys: [{ id: "o1", time: 0 as never, value: 0.5, segmentToNext: "linear", tangentMode: "flat" }] } } }, params: base, zooms: [zoom()], newId: ids });
    const second = autoZoomAnimations({ animations: first, params: base, zooms: [zoom({ scale: 3 })], newId: ids });
    for (const path of AUTO_ZOOM_PATHS) {
      expect(second[path]?.kind).toBe("channel");
      const keys = second[path]?.kind === "channel" ? (second[path].channel as { keys: unknown[] }).keys : [];
      expect(keys).toHaveLength(4);
    }
    expect(second["opacity"]).toBeDefined();
  });
});

describe("autoZoomProblem", () => {
  const problem = (zooms: AutoZoom[], clipDuration = sec(10)) => autoZoomProblem({ zooms, clipDuration });
  it("accepts ordered, separate zooms inside the clip", () => {
    expect(problem([zoom(), zoom({ at: sec(4) })])).toBeNull();
  });
  it("explains each way a list can be wrong", () => {
    expect(problem([])).toMatch(/no zooms/);
    expect(problem(Array.from({ length: 9 }, (_, i) => zoom({ at: sec(i) * 1 })))).toMatch(/limit/);
    expect(problem([zoom({ scale: 1 })])).toMatch(/scale/);
    expect(problem([zoom({ scale: 9 })])).toMatch(/scale/);
    expect(problem([zoom({ at: -1 })])).toMatch(/before the clip/);
    expect(problem([zoom({ at: sec(9) })])).toMatch(/past the end/);
    expect(problem([zoom(), zoom({ at: sec(2) })])).toMatch(/before zoom 1/);
    expect(problem([zoom({ inTicks: 0 })])).toMatch(/ease-in/);
    expect(problem([zoom({ x: Number.NaN })])).toMatch(/finite/);
  });
});

describe("autoZoomCommand", () => {
  function setup(element: VideoElement | ImageElement) {
    const { editor } = makeEditor();
    const main = editor.tracks().main.id;
    editor.execute(insertElement({ element, placement: { mode: "explicit", trackId: main } }));
    return { editor, ref: { trackId: main, elementId: element.id } };
  }
  const get = (editor: ReturnType<typeof setup>["editor"], id: string) => allElements(editor.tracks()).find((l) => l.element.id === id)!.element;

  it("zooms a video or an image in one undo step", () => {
    for (const clip of [video("v", 0, 10), image("i", 0, 10)]) {
      const { editor, ref } = setup(clip);
      editor.execute(autoZoomCommand({ ref, zooms: [zoom()] }));
      expect(resolveElementParams(get(editor, clip.id), sec(2))[PARAM.scaleX]).toBe(2);
      editor.undo();
      expect(get(editor, clip.id).animations).toBeUndefined();
    }
  });
  it("refuses text and bad lists without changing the clip", () => {
    const { editor, ref } = setup(video("v", 0, 10));
    expect(() => editor.execute(autoZoomCommand({ ref, zooms: [zoom({ at: sec(30) })] }))).toThrow(/Cannot apply auto zoom/);
    expect(get(editor, "v").animations).toBeUndefined();
    const t = text("t", 0, 5);
    editor.execute(insertElement({ element: t, placement: { mode: "newTrack", index: 0, trackId: "txt" } }));
    expect(() => editor.execute(autoZoomCommand({ ref: { trackId: "txt", elementId: "t" }, zooms: [zoom()] }))).toThrow(/video, image and graphic/);
  });
});

describe("zoomAtPlayhead", () => {
  const point = { x: 120, y: -40 };
  it("uses the full ease and hold when there is room", () => {
    expect(zoomAtPlayhead({ at: 0, clipDuration: 10 * TICKS_PER_SECOND, point, scale: 2, holdSeconds: 1.5 }))
      .toEqual({ at: 0, x: 120, y: -40, scale: 2, inTicks: 0.6 * TICKS_PER_SECOND, holdTicks: 1.5 * TICKS_PER_SECOND, outTicks: 0.6 * TICKS_PER_SECOND });
  });
  it("shrinks proportionally near the end of the clip and always fits", () => {
    const z = zoomAtPlayhead({ at: 8 * TICKS_PER_SECOND, clipDuration: 10 * TICKS_PER_SECOND, point, scale: 2, holdSeconds: 1.5 })!;
    expect(z.at + z.inTicks + z.holdTicks + z.outTicks).toBeLessThanOrEqual(10 * TICKS_PER_SECOND);
    expect(z.inTicks).toBeLessThan(0.6 * TICKS_PER_SECOND);
    expect(autoZoomProblem({ zooms: [z], clipDuration: 10 * TICKS_PER_SECOND })).toBeNull();
  });
  it("gives up when not even the shortest zoom fits", () => {
    expect(zoomAtPlayhead({ at: 9.95 * TICKS_PER_SECOND, clipDuration: 10 * TICKS_PER_SECOND, point, scale: 2, holdSeconds: 1 })).toBeNull();
  });
});

describe("auto_zoom agent tool", () => {
  it("zooms in timeline seconds and reports problems with hints", async () => {
    const h = setupAgent();
    const { elementId } = await h.data<{ elementId: string }>("insert_media", { assetId: "a1" });
    await h.data("auto_zoom", { elementId, zooms: [{ at: 2, x: 400, y: 100, scale: 2.5, hold: 1 }] });
    const el = allElements(h.editor.tracks()).find((l) => l.element.id === elementId)!.element;
    expect(resolveElementParams(el, sec(3))[PARAM.scaleX]).toBeCloseTo(2.5, 6);
    expect(resolveElementParams(el, sec(6))[PARAM.scaleX]).toBeCloseTo(1, 6);
    expect((await h.failure("auto_zoom", { elementId, zooms: [{ at: 50, x: 0, y: 0 }] })).hint).toContain("inside the clip");
    expect((await h.failure("auto_zoom", { elementId, zooms: [{ at: 1, x: 0, y: 0, scale: 1 }] })).error.length).toBeGreaterThan(0);
    const label = await h.data<{ elementId: string }>("insert_text", { text: "hi", start: 0, duration: 3 });
    expect((await h.failure("auto_zoom", { elementId: label.elementId, zooms: [{ at: 0, x: 0, y: 0 }] })).error).toContain("text");
  });
});
