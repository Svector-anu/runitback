import { describe, expect, it } from "vitest";
import { buildFramePlan, blurSigma, computeVisualTransform, drawOrder, type MediaLayer, type TextLayer } from "#/engine/render";
import { mediaTime, TICKS_PER_SECOND } from "#/engine/time";
import { sequentialIds, buildEffectElement, buildGraphicElement, type VideoElement } from "#/engine/model";
import { upsertKeyframe } from "#/engine/animation";
import { allElements } from "#/engine/timeline";
import { sec, text, tracksWith, video, videoAsset } from "./helpers";

const canvas = { width: 1920, height: 1080 };
const bg = { type: "color", color: "#000000" } as const;
const assetsFor = (tracks: ReturnType<typeof tracksWith>) => allElements(tracks).map((l) => videoAsset(`asset-${l.element.id}`));
const plan = (tracks: ReturnType<typeof tracksWith>, time: number, assets = assetsFor(tracks), background: Parameters<typeof buildFramePlan>[0]["background"] = bg) =>
  buildFramePlan({ tracks, canvas, background, assets, time });

describe("buildFramePlan", () => {
  it("only elements active at the playhead are drawn (end exclusive)", () => {
    const tracks = tracksWith({ main: [video("a", 0, 5)] });
    expect(plan(tracks, 0).items).toHaveLength(1);
    expect(plan(tracks, sec(5) - 1).items).toHaveLength(1);
    expect(plan(tracks, sec(5)).items).toHaveLength(0);
    expect(plan(tracks, sec(5)).backgroundColor).toBe("#000000");
  });
  it("maps timeline time to source time with trims and speed", () => {
    const el = video("a", 2, 4, { trimStart: sec(1), retime: { rate: 2 }, duration: sec(4), sourceDuration: sec(10) });
    const tracks = tracksWith({ main: [el] });
    const layer = plan(tracks, sec(3)).items[0] as MediaLayer;
    expect(layer.source).toMatchObject({ type: "video", sourceSeconds: 1 + 1 * 2 });
    const start = plan(tracks, sec(2)).items[0] as MediaLayer;
    expect(start.source).toMatchObject({ sourceSeconds: 1 });
    const unspeed = plan(tracksWith({ main: [video("a", 3, 4, { trimStart: sec(2) })] }), sec(5)).items[0] as MediaLayer;
    expect(unspeed.source).toMatchObject({ sourceSeconds: 4 });
  });
  it("draw order is main first then overlays bottom to top; later starts draw on top within a track", () => {
    const tracks = tracksWith({
      main: [video("m", 0, 10)],
      overlay: [{ id: "top", elements: [video("t", 0, 10)] }, { id: "mid", elements: [video("b1", 0, 10), video("b2", 0, 10)] }],
    });
    expect(drawOrder(tracks).map((t) => t.id)).toEqual(["main", "mid", "top"]);
    expect(plan(tracks, sec(1)).items.map((i) => i.elementId)).toEqual(["m", "b1", "b2", "t"]);
  });
  it("hidden tracks and hidden elements are skipped", () => {
    const tracks = tracksWith({ main: [video("a", 0, 5, { hidden: true }), video("b", 0, 5)], overlay: [{ id: "o", elements: [video("c", 0, 5)] }] });
    const hiddenTrack = { ...tracks, overlay: tracks.overlay.map((t) => ({ ...t, hidden: true })) } as typeof tracks;
    expect(plan(hiddenTrack, sec(1)).items.map((i) => i.elementId)).toEqual(["b"]);
  });
  it("overlapping multi-track clips all render at once", () => {
    const tracks = tracksWith({ main: [video("a", 0, 10)], overlay: [{ id: "o", elements: [video("b", 5, 10)] }] });
    expect(plan(tracks, sec(2)).items).toHaveLength(1);
    expect(plan(tracks, sec(7)).items).toHaveLength(2);
  });
  it("missing media is reported, not drawn", () => {
    const tracks = tracksWith({ main: [video("a", 0, 5)] });
    const r = plan(tracks, sec(1), []);
    expect(r.items).toHaveLength(0);
    expect(r.missingMedia).toEqual(["a"]);
  });
  it("animated opacity is resolved at clip-local time", () => {
    const newId = sequentialIds();
    let animations = upsertKeyframe({ animations: undefined, path: "opacity", time: mediaTime(0), value: 0, newId });
    animations = upsertKeyframe({ animations, path: "opacity", time: sec(4), value: 1, newId });
    const tracks = tracksWith({ main: [video("a", 2, 4, { animations })] });
    expect((plan(tracks, sec(4)).items[0] as MediaLayer).opacity).toBeCloseTo(0.5);
  });
  it("params feed transform: contain fit, position from centre, scale, flip, rotation", () => {
    const t = computeVisualTransform({ canvas, sourceWidth: 1000, sourceHeight: 1000, params: { "transform.positionX": 100, "transform.positionY": -50, "transform.scaleX": -2, "transform.scaleY": 0.5, "transform.rotate": 30 } });
    expect(t).toMatchObject({ centerX: 1060, centerY: 490, width: 2160, height: 540, flipX: true, flipY: false, rotationDegrees: 30 });
    const unit = computeVisualTransform({ canvas, sourceWidth: 1920, sourceHeight: 1080, params: {} });
    expect(unit).toMatchObject({ width: 1920, height: 1080, centerX: 960, centerY: 540 });
    const tall = computeVisualTransform({ canvas, sourceWidth: 1080, sourceHeight: 1920, params: {} });
    expect(tall.height).toBe(1080);
    expect(tall.width).toBeCloseTo(607.5);
  });
  it("text, graphics and effect elements become their own items", () => {
    const g = buildGraphicElement({ id: "g", startTime: sec(0), definitionId: "star", params: { fill: "#ff0000" } });
    const fx = buildEffectElement({ id: "fx", startTime: sec(0), effectType: "blur", params: { intensity: 30 } });
    const tracks = tracksWith({
      main: [video("a", 0, 10)],
      overlay: [{ id: "e", type: "effect", elements: [fx] }, { id: "g", type: "graphic", elements: [g] }, { id: "t", type: "text", elements: [text("x", 0, 10)] }],
    });
    const items = plan(tracks, sec(1)).items;
    expect(items.map((i) => i.kind)).toEqual(["layer", "text", "layer", "sceneEffect"]);
    expect(items.map((i) => i.elementId)).toEqual(["a", "x", "g", "fx"]);
    expect((items[1] as TextLayer).params.content).toBe("Default text");
    expect(items[3]).toMatchObject({ kind: "sceneEffect", effects: [{ type: "blur", params: { intensity: 30 } }] });
  });
  it("scene effects only affect what was drawn before them (tracks beneath)", () => {
    const fx = buildEffectElement({ id: "fx", startTime: sec(0), effectType: "blur", params: { intensity: 30 } });
    const tracks = tracksWith({
      main: [video("a", 0, 10)],
      overlay: [{ id: "up", elements: [video("above", 0, 10)] }, { id: "e", type: "effect", elements: [fx] }],
    });
    expect(plan(tracks, sec(1)).items.map((i) => i.elementId)).toEqual(["a", "fx", "above"]);
  });
  it("per-clip effects resolve enabled effects only, with their params", () => {
    const el = video("a", 0, 5, { effects: [{ id: "f1", type: "blur", params: { intensity: 40 }, enabled: true }, { id: "f2", type: "blur", params: { intensity: 9 }, enabled: false }] });
    const layer = plan(tracksWith({ main: [el] }), sec(1)).items[0] as MediaLayer;
    expect(layer.effects).toEqual([{ type: "blur", params: { intensity: 40 } }]);
  });
  it("only the first mask is used", () => {
    const el: VideoElement = video("a", 0, 5, { masks: [{ id: "m1", type: "ellipse", params: { feather: 5 } }, { id: "m2", type: "star", params: {} }] });
    const layer = plan(tracksWith({ main: [el] }), sec(1)).items[0] as MediaLayer;
    expect(layer.mask?.mask.id).toBe("m1");
  });
  it("blur background adds one cover item per main-track clip beneath everything", () => {
    const tracks = tracksWith({ main: [video("a", 0, 5)], overlay: [{ id: "o", elements: [video("b", 0, 5)] }] });
    const r = plan(tracks, sec(1), undefined, { type: "blur", blurIntensity: 100 });
    expect(r.backgroundColor).toBeNull();
    expect(r.items[0]).toMatchObject({ kind: "blurBackground", elementId: "a", intensity: 100 });
    expect(r.items.filter((i) => i.kind === "blurBackground")).toHaveLength(1);
  });
  it("blur sigma scales with intensity and drawn size", () => {
    expect(blurSigma({ intensity: 15, width: 1920, height: 1080 })).toEqual({ x: 3, y: 3 });
    expect(blurSigma({ intensity: 15, width: 960, height: 540 })).toEqual({ x: 1.5, y: 1.5 });
  });
  it("source seconds stay exact across the tick grid", () => {
    const tracks = tracksWith({ main: [video("a", 0, 10)] });
    const layer = plan(tracks, 5000).items[0] as MediaLayer;
    expect((layer.source as { sourceSeconds: number }).sourceSeconds).toBeCloseTo(5000 / TICKS_PER_SECOND);
  });
});
