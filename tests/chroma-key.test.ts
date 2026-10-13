import { describe, expect, it } from "vitest";
import { applyChromaKey, buildFramePlan, canvasPointToSourceUv, chromaKeyIsNoop, chromaKeyPlan, keyPixel, parseHexColor, type MediaLayer } from "#/engine/render";
import { EFFECT_DEFINITIONS, LAYER_EFFECT_TYPES, defaultsOf } from "#/engine/model";
import { setupAgent, type InsertedData } from "./agent-harness";
import { sec, tracksWith, video, videoAsset } from "./helpers";

const W = 64, H = 36;
const SUBJECT = { x0: 20, x1: 44, y0: 8, y1: 30 };

/** A green-screen frame: #00ff00 everywhere except a red-skinned "subject" with a green-tinted rim (spill). */
function greenScreenFrame(): Uint8ClampedArray {
  const data = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const inside = x >= SUBJECT.x0 && x < SUBJECT.x1 && y >= SUBJECT.y0 && y < SUBJECT.y1;
    const rim = inside && (x < SUBJECT.x0 + 2 || x >= SUBJECT.x1 - 2);
    const [r, g, b] = rim ? [190, 190, 60] : inside ? [200, 60, 50] : [0, 255, 0];
    data.set([r, g, b, 255], (y * W + x) * 4);
  }
  return data;
}
const alphaAt = (data: Uint8ClampedArray, x: number, y: number): number => data[(y * W + x) * 4 + 3] as number;
const pixelAt = (data: Uint8ClampedArray, x: number, y: number): number[] => Array.from(data.slice((y * W + x) * 4, (y * W + x) * 4 + 4));

describe("chroma key maths", () => {
  const plan = chromaKeyPlan(defaultsOf(EFFECT_DEFINITIONS["chroma-key"]!.params));

  it("makes the screen transparent and keeps the subject opaque and unchanged", () => {
    const frame = greenScreenFrame();
    applyChromaKey(frame, plan);
    expect(alphaAt(frame, 2, 2)).toBe(0);
    expect(alphaAt(frame, 62, 34)).toBe(0);
    expect(alphaAt(frame, 32, 18)).toBe(255);
    expect(pixelAt(frame, 32, 18).slice(0, 3)).toEqual([200, 60, 50]);
    let transparent = 0;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const inside = x >= SUBJECT.x0 && x < SUBJECT.x1 && y >= SUBJECT.y0 && y < SUBJECT.y1;
      if (!inside && alphaAt(frame, x, y) === 0) transparent++;
      if (inside) expect(alphaAt(frame, x, y)).toBeGreaterThan(200);
    }
    expect(transparent).toBe(W * H - (SUBJECT.x1 - SUBJECT.x0) * (SUBJECT.y1 - SUBJECT.y0));
  });

  it("keys a screen that is shadowed or compressed (brightness changes, same hue)", () => {
    for (const g of [255, 200, 140, 90]) expect(keyPixel(plan, 0, g, 0).alpha).toBe(0);
    for (const [r, b] of [[12, 8], [20, 25], [0, 30]] as const) expect(keyPixel(plan, r, 230, b).alpha).toBe(0);
  });

  it("does not key skin tones, white, black or blue with the default green key", () => {
    for (const [r, g, b] of [[224, 172, 140], [255, 255, 255], [0, 0, 0], [30, 60, 220], [128, 128, 128]] as const) {
      expect(keyPixel(plan, r, g, b).alpha, `${r},${g},${b}`).toBe(1);
    }
  });

  it("similarity widens and smoothness softens the matte", () => {
    const olive = [90, 200, 60] as const;
    const tight = chromaKeyPlan({ similarity: 5, smoothness: 0 });
    const wide = chromaKeyPlan({ similarity: 60, smoothness: 0 });
    expect(keyPixel(tight, ...olive).alpha).toBe(1);
    expect(keyPixel(wide, ...olive).alpha).toBe(0);
    const soft = chromaKeyPlan({ similarity: 20, smoothness: 30 });
    const alphas = [[0, 255, 0], [60, 220, 40], [110, 190, 60], [160, 160, 80], [220, 80, 60]].map(([r, g, b]) => keyPixel(soft, r!, g!, b!).alpha);
    expect(alphas[0]).toBe(0);
    expect(alphas[4]).toBe(1);
    for (let i = 1; i < alphas.length; i++) expect(alphas[i]!).toBeGreaterThanOrEqual(alphas[i - 1]!);
    expect(alphas.some((a) => a > 0 && a < 1)).toBe(true);
  });

  it("spill suppression removes the green cast from kept pixels and leaves neutral ones", () => {
    const withSpill = chromaKeyPlan({ similarity: 30, smoothness: 10, spill: 100 });
    const without = chromaKeyPlan({ similarity: 30, smoothness: 10, spill: 0 });
    const rim = [190, 190, 60] as const;
    const a = keyPixel(without, ...rim), b = keyPixel(withSpill, ...rim);
    expect(a.alpha).toBe(1);
    expect(b.g - (b.r + b.b) / 2).toBeLessThan(a.g - (a.r + a.b) / 2);
    expect(keyPixel(withSpill, 128, 128, 128)).toMatchObject({ r: 128, g: 128, b: 128 });
    expect(keyPixel(withSpill, 200, 60, 50)).toMatchObject({ r: 200, g: 60, b: 50 });
  });

  it("works for a blue key and multiplies the clip's own alpha", () => {
    const blue = chromaKeyPlan({ keyColor: "#0000ff", similarity: 30, smoothness: 10 });
    expect(keyPixel(blue, 0, 0, 255).alpha).toBe(0);
    expect(keyPixel(blue, 0, 255, 0).alpha).toBe(1);
    const px = new Uint8ClampedArray([0, 255, 0, 100, 200, 60, 50, 100, 5, 5, 5, 0]);
    applyChromaKey(px, plan);
    expect(Array.from(px.filter((_, i) => i % 4 === 3))).toEqual([0, 100, 0]);
  });

  it("is a no-op for similarity 0 with no smoothness, and parses colours", () => {
    expect(chromaKeyIsNoop(chromaKeyPlan({ similarity: 0, smoothness: 0 }))).toBe(true);
    expect(chromaKeyIsNoop(plan)).toBe(false);
    expect(parseHexColor("#00FF00")).toEqual([0, 255, 0]);
    expect(parseHexColor("nope")).toBeNull();
    expect(chromaKeyPlan({ keyColor: "garbage" }).keyCb).toBeCloseTo(chromaKeyPlan({}).keyCb);
  });
});

describe("chroma key in the document", () => {
  it("is a clip-only effect: not offered as a scene-wide layer", () => {
    expect(EFFECT_DEFINITIONS["chroma-key"]?.scope).toBe("clip");
    expect(LAYER_EFFECT_TYPES).not.toContain("chroma-key");
    expect(LAYER_EFFECT_TYPES).toContain("blur");
  });

  it("reaches the frame plan with resolved params, on an overlay clip above a lower track", () => {
    const top = video("top", 0, 4, { effects: [{ id: "k", type: "chroma-key", enabled: true, params: { keyColor: "#00ff00", similarity: 40, smoothness: 10, spill: 50 } }] });
    const tracks = tracksWith({ main: [video("base", 0, 4)], overlay: [{ id: "o1", elements: [top] }] });
    const plan = buildFramePlan({ tracks, canvas: { width: 1920, height: 1080 }, background: { type: "color", color: "#000" }, assets: [videoAsset("asset-base", 4), videoAsset("asset-top", 4)], time: sec(1) });
    const layers = plan.items.filter((i): i is MediaLayer => i.kind === "layer");
    expect(layers.map((l) => l.elementId)).toEqual(["base", "top"]);
    expect(layers[1]?.effects).toEqual([{ type: "chroma-key", params: { keyColor: "#00ff00", similarity: 40, smoothness: 10, spill: 50 } }]);
    expect(layers[0]?.effects).toEqual([]);
  });

  it("add_effect rejects out-of-range values and insert_effect_layer refuses a clip-only effect", async () => {
    const h = setupAgent();
    const clip = await h.data<InsertedData>("insert_media", { assetId: "a1" });
    await h.failure("add_effect", { elementId: clip.elementId, effectType: "chroma-key", params: { similarity: 500 } });
    await h.failure("insert_effect_layer", { effectType: "chroma-key" });
  });
});

describe("canvasPointToSourceUv (eyedropper mapping)", () => {
  const base = { centerX: 960, centerY: 540, width: 1000, height: 500, rotationDegrees: 0, flipX: false, flipY: false };
  it("maps the layer centre and corners to the source picture", () => {
    expect(canvasPointToSourceUv({ transform: base, crop: null, point: { x: 960, y: 540 } })).toEqual({ u: 0.5, v: 0.5 });
    expect(canvasPointToSourceUv({ transform: base, crop: null, point: { x: 460, y: 290 } })).toEqual({ u: 0, v: 0 });
    expect(canvasPointToSourceUv({ transform: base, crop: null, point: { x: 1460, y: 790 } })).toEqual({ u: 1, v: 1 });
    expect(canvasPointToSourceUv({ transform: base, crop: null, point: { x: 100, y: 540 } })).toBeNull();
  });
  it("undoes rotation and flips, and refuses cropped-away points", () => {
    const rotated = { ...base, rotationDegrees: 90 };
    const uv = canvasPointToSourceUv({ transform: rotated, crop: null, point: { x: 960, y: 540 + 250 } });
    expect(uv?.u).toBeCloseTo(0.75, 6);
    expect(uv?.v).toBeCloseTo(0.5, 6);
    const flipped = canvasPointToSourceUv({ transform: { ...base, flipX: true }, crop: null, point: { x: 960 + 250, y: 540 } });
    expect(flipped?.u).toBeCloseTo(0.25, 6);
    expect(canvasPointToSourceUv({ transform: base, crop: { left: 0.4, top: 0, right: 0, bottom: 0 }, point: { x: 560, y: 540 } })).toBeNull();
    expect(canvasPointToSourceUv({ transform: base, crop: { left: 0.4, top: 0, right: 0, bottom: 0 }, point: { x: 960, y: 540 } })?.u).toBe(0.5);
  });
});
