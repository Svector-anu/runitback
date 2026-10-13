import { describe, expect, it } from "vitest";
import { addClipEffect, insertElement, upsertKeyframeCommand } from "#/engine/commands";
import { EFFECT_DEFINITIONS, MASK_DEFINITIONS, PARAM, clampParams, limitsForEffect, type GraphicElement, type VideoElement } from "#/engine/model";
import {
  affineBetween, buildFramePlan, projectTilted, resolveTilt, rotatedBox, tiltMesh, TILT_MAX_CELLS,
  type MediaLayer, type Point2, type TextLayer,
} from "#/engine/render";
import { allElements, resolveElementParams } from "#/engine/timeline";
import { maskShape } from "#/render/masks";
import { setupAgent } from "./agent-harness";
import { makeEditor, sec, text, tracksWith, video, videoAsset } from "./helpers";

describe("perspective maths", () => {
  it("is flat without tilt and clamps what it is given", () => {
    expect(resolveTilt({})).toBeNull();
    expect(resolveTilt({ [PARAM.rotateX]: 0.001 })).toBeNull();
    expect(resolveTilt({ [PARAM.rotateY]: 30 })).toEqual({ x: 0, y: 30, perspective: 2 });
    expect(resolveTilt({ [PARAM.rotateX]: 500, [PARAM.perspective]: 99 })).toEqual({ x: 80, y: 0, perspective: 10 });
    expect(resolveTilt({ [PARAM.rotateX]: 10, [PARAM.perspective]: 0 })?.perspective).toBe(1);
  });
  it("leaves the centre alone and keeps a flat layer flat", () => {
    expect(projectTilted({ p: { x: 0, y: 0 }, tilt: { x: 40, y: 25 }, distance: 1000 })).toEqual({ x: 0, y: 0 });
    const flat = projectTilted({ p: { x: 120, y: -80 }, tilt: { x: 0, y: 0 }, distance: 1000 });
    expect(flat.x).toBeCloseTo(120, 9);
    expect(flat.y).toBeCloseTo(-80, 9);
  });
  it("tips the named edge away from the viewer so it shrinks, and the opposite edge toward it so it grows", () => {
    const top = projectTilted({ p: { x: 0, y: -100 }, tilt: { x: 40, y: 0 }, distance: 500 });
    const bottom = projectTilted({ p: { x: 0, y: 100 }, tilt: { x: 40, y: 0 }, distance: 500 });
    expect(Math.abs(top.y)).toBeLessThan(Math.abs(bottom.y));
    const right = projectTilted({ p: { x: 100, y: 0 }, tilt: { x: 0, y: 40 }, distance: 500 });
    const left = projectTilted({ p: { x: -100, y: 0 }, tilt: { x: 0, y: 40 }, distance: 500 });
    expect(Math.abs(right.x)).toBeLessThan(Math.abs(left.x));
    const wide = projectTilted({ p: { x: 100, y: -100 }, tilt: { x: 40, y: 0 }, distance: 500 });
    expect(Math.abs(wide.x)).toBeLessThan(100);
  });
  it("a stronger perspective (nearer camera) bends more than a distant one", () => {
    const at = (distance: number) => projectTilted({ p: { x: 0, y: 100 }, tilt: { x: 50, y: 0 }, distance }).y;
    expect(Math.abs(at(300) - 100 * Math.cos(Math.PI * 50 / 180))).toBeGreaterThan(Math.abs(at(5000) - 100 * Math.cos(Math.PI * 50 / 180)));
  });
  it("never divides by zero, even with the camera inside the layer's reach", () => {
    const p = projectTilted({ p: { x: 5000, y: 5000 }, tilt: { x: 80, y: 80 }, distance: 10 });
    expect(Number.isFinite(p.x) && Number.isFinite(p.y)).toBe(true);
  });
});

describe("affineBetween", () => {
  const triangle: [Point2, Point2, Point2] = [{ x: 10, y: 20 }, { x: 110, y: 30 }, { x: 40, y: 90 }];
  const target: [Point2, Point2, Point2] = [{ x: 200, y: 50 }, { x: 260, y: 40 }, { x: 230, y: 160 }];
  it("maps every corner of one triangle onto the other", () => {
    const m = affineBetween(triangle, target)!;
    triangle.forEach((p, i) => {
      expect(m.a * p.x + m.c * p.y + m.e).toBeCloseTo((target[i] as Point2).x, 6);
      expect(m.b * p.x + m.d * p.y + m.f).toBeCloseTo((target[i] as Point2).y, 6);
    });
  });
  it("is the identity for identical triangles and null for a degenerate one", () => {
    expect(affineBetween(triangle, triangle)).toEqual(expect.objectContaining({ a: expect.closeTo(1, 9), d: expect.closeTo(1, 9), e: expect.closeTo(0, 9), f: expect.closeTo(0, 9) }));
    expect(affineBetween([{ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 2 }], target)).toBeNull();
  });
});

describe("tiltMesh", () => {
  const box = { left: 100, top: 50, width: 600, height: 300 };
  const area = (t: Point2[]): number => Math.abs(((t[1] as Point2).x - (t[0] as Point2).x) * ((t[2] as Point2).y - (t[0] as Point2).y) - ((t[2] as Point2).x - (t[0] as Point2).x) * ((t[1] as Point2).y - (t[0] as Point2).y)) / 2;
  it("tiles the content box exactly and lands at the projection of its corners", () => {
    const pivot = { x: 400, y: 200 };
    const mesh = tiltMesh({ box, pivot, tilt: { x: 30, y: 20, perspective: 2 } });
    expect(mesh.reduce((sum, t) => sum + area(t.src), 0)).toBeCloseTo(box.width * box.height, 4);
    const xs = mesh.flatMap((t) => t.dst.map((p) => p.x));
    expect(Math.max(...xs)).toBeGreaterThan(pivot.x);
    const corner = projectTilted({ p: { x: box.left - pivot.x, y: box.top - pivot.y }, tilt: { x: 30, y: 20 }, distance: 2 * 600 });
    expect(mesh.some((t) => t.dst.some((p) => Math.abs(p.x - (pivot.x + corner.x)) < 1e-9 && Math.abs(p.y - (pivot.y + corner.y)) < 1e-9))).toBe(true);
  });
  it("with no tilt the destination is the source", () => {
    for (const t of tiltMesh({ box, pivot: { x: 400, y: 200 }, tilt: { x: 0, y: 0, perspective: 2 } })) {
      t.src.forEach((p, i) => { expect((t.dst[i] as Point2).x).toBeCloseTo(p.x, 9); expect((t.dst[i] as Point2).y).toBeCloseTo(p.y, 9); });
    }
  });
  it("bounds the work for huge boxes", () => {
    const mesh = tiltMesh({ box: { left: 0, top: 0, width: 8000, height: 8000 }, pivot: { x: 4000, y: 4000 }, tilt: { x: 20, y: 20, perspective: 2 } });
    expect(mesh.length).toBeLessThanOrEqual(2 * TILT_MAX_CELLS * TILT_MAX_CELLS);
  });
  it("boxes a rotated rectangle", () => {
    const b = rotatedBox({ center: { x: 500, y: 300 }, width: 200, height: 100, degrees: 90 });
    expect(b.width).toBeCloseTo(100, 9);
    expect(b.height).toBeCloseTo(200, 9);
    expect(b.left).toBeCloseTo(450, 9);
  });
});

describe("tilt in the frame plan", () => {
  const canvas = { width: 1920, height: 1080 };
  const plan = (tracks: ReturnType<typeof tracksWith>) => buildFramePlan({ tracks, canvas, background: { type: "color", color: "#000" }, assets: [videoAsset("asset-v"), videoAsset("asset-g")], time: sec(1) });
  it("is null by default and carried on video, text and graphic layers when set", () => {
    const flat = plan(tracksWith({ main: [video("v", 0, 4)] })).items[0] as MediaLayer;
    expect(flat.tilt).toBeNull();
    const tilted = video("v", 0, 4, { params: { ...video("v", 0, 4).params, [PARAM.rotateY]: 25 } });
    expect((plan(tracksWith({ main: [tilted] })).items[0] as MediaLayer).tilt).toEqual({ x: 0, y: 25, perspective: 2 });
    const t = text("t", 0, 4);
    const tl = plan(tracksWith({ overlay: [{ id: "x", type: "text", elements: [{ ...t, params: { ...t.params, [PARAM.rotateX]: -15 } }] }] })).items[0] as TextLayer;
    expect(tl.tilt).toEqual({ x: -15, y: 0, perspective: 2 });
  });
});

describe("tilt is keyframeable even where a clip never stored it", () => {
  it("a keyframe on an absent parameter creates its base so the animation resolves", () => {
    const { editor } = makeEditor();
    const clip = video("v", 0, 6);
    editor.execute(insertElement({ element: clip, placement: { mode: "explicit", trackId: editor.tracks().main.id } }));
    const ref = { trackId: editor.tracks().main.id, elementId: "v" };
    expect(clip.params[PARAM.rotateY]).toBeUndefined();
    editor.execute(upsertKeyframeCommand({ ref, path: PARAM.rotateY, time: 0, value: 0 }));
    editor.execute(upsertKeyframeCommand({ ref, path: PARAM.rotateY, time: sec(2), value: 40 }));
    const element = allElements(editor.tracks()).find((l) => l.element.id === "v")!.element as VideoElement;
    expect(resolveElementParams(element, sec(1))[PARAM.rotateY]).toBeCloseTo(20, 6);
    expect(resolveElementParams(element, sec(5))[PARAM.rotateY]).toBe(40);
  });
});

describe("agent access", () => {
  it("set_params reaches tilt and rejects out-of-range angles", async () => {
    const h = setupAgent();
    const { elementId } = await h.data<{ elementId: string }>("insert_media", { assetId: "a1" });
    await h.data("set_params", { elementIds: [elementId], params: { "transform.rotateX": 20, "transform.rotateY": -35, "transform.perspective": 1.5 } });
    const params = allElements(h.editor.tracks()).find((l) => l.element.id === elementId)!.element.params;
    expect(params).toMatchObject({ "transform.rotateX": 20, "transform.rotateY": -35, "transform.perspective": 1.5 });
    expect((await h.failure("set_params", { elementIds: [elementId], params: { "transform.rotateX": 120 } })).error).toContain("maximum");
  });
});

describe("shadow effect", () => {
  it("is a clip effect with bounded parameters", () => {
    const def = EFFECT_DEFINITIONS["shadow"]!;
    expect(def.scope).toBe("clip");
    expect(def.params.map((p) => p.key)).toEqual(["color", "opacity", "blur", "offsetX", "offsetY"]);
    expect(clampParams({ blur: 5000, offsetX: -9000, opacity: 400 }, limitsForEffect({ type: "shadow" }))).toEqual({ blur: 200, offsetX: -400, opacity: 100 });
  });
  it("can be added to a clip, a graphic and text through the editor and the agent, and is not a scene layer", async () => {
    const { editor } = makeEditor();
    editor.execute(insertElement({ element: video("v", 0, 4), placement: { mode: "explicit", trackId: editor.tracks().main.id } }));
    editor.execute(addClipEffect({ ref: { trackId: editor.tracks().main.id, elementId: "v" }, effectType: "shadow" }));
    expect((allElements(editor.tracks()).find((l) => l.element.id === "v")!.element as VideoElement).effects?.[0]).toMatchObject({ type: "shadow", params: { opacity: 40, blur: 40, offsetY: 24 } });
    const h = setupAgent();
    const g = await h.data<{ elementId: string }>("insert_graphic", { shape: "rectangle" });
    await h.data("add_effect", { elementId: g.elementId, effectType: "shadow", params: { blur: 60, offsetY: 30 } });
    const located = allElements(h.editor.tracks()).find((l) => l.element.id === g.elementId)!.element as GraphicElement;
    expect(located.effects?.[0]?.params).toMatchObject({ blur: 60, offsetY: 30 });
    expect((await h.failure("insert_effect_layer", { effectType: "shadow" })).hint).toContain("adjust");
  });
});

describe("rounded rectangle mask", () => {
  it("stays a plain polygon until a radius is set, then becomes a rounded box scaled to the shorter side", () => {
    expect(maskShape("rectangle", { width: 0.5, height: 0.5 }, 200, 100).kind).toBe("polygon");
    const shape = maskShape("rectangle", { width: 0.5, height: 0.5, cornerRadius: 25 }, 200, 100);
    expect(shape).toMatchObject({ kind: "roundRect", w: 100, h: 50, radius: 12.5 });
    expect(maskShape("rectangle", { width: 1, height: 1, cornerRadius: 50 }, 200, 100)).toMatchObject({ radius: 50 });
    expect(maskShape("rectangle", { width: 1, height: 1, cornerRadius: 900 }, 200, 100)).toMatchObject({ radius: 50 });
    expect(MASK_DEFINITIONS.rectangle.params.some((p) => p.key === "cornerRadius")).toBe(true);
  });
});
