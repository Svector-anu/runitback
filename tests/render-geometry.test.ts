import { describe, expect, it } from "vitest";
import { layoutText, scaledFontSize } from "#/render/text";
import { polygonVertices, starVertices } from "#/render/graphics";
import { maskShape } from "#/render/masks";
import { compositeOperation } from "#/render/compositor";
import { BLEND_MODES, TEXT_DEFAULTS } from "#/engine/model";

const measure = (line: string) => line.length * 10;

describe("text layout", () => {
  it("scales font size against a 90-unit canvas height", () => {
    expect(scaledFontSize(15, 1080)).toBe(180);
    expect(scaledFontSize(5, 1080)).toBe(60);
  });
  it("centres multi-line blocks around the anchor and anchors alignment at x=0", () => {
    const l = layoutText({ params: { ...TEXT_DEFAULTS, content: "ab\nabcd", fontSize: 15, lineHeight: 1.2 }, canvasHeight: 1080, measure });
    expect(l.lines).toEqual(["ab", "abcd"]);
    expect(l.lineHeightPx).toBeCloseTo(216);
    expect(l.lineYs).toEqual([-108, 108]);
    expect(l.textRect).toMatchObject({ left: -20, width: 40, height: 432, top: -216 });
    const left = layoutText({ params: { ...TEXT_DEFAULTS, content: "abcd", textAlign: "left" }, canvasHeight: 1080, measure });
    expect(left.textRect.left).toBe(0);
    const right = layoutText({ params: { ...TEXT_DEFAULTS, content: "abcd", textAlign: "right" }, canvasHeight: 1080, measure });
    expect(right.textRect.left).toBe(-40);
  });
  it("builds the background box with padding scaled by font size and rounded by percent", () => {
    const l = layoutText({
      params: { ...TEXT_DEFAULTS, content: "abcd", fontSize: 30, "background.enabled": true, "background.paddingX": 10, "background.paddingY": 20, "background.cornerRadius": 100, "background.offsetX": 5 },
      canvasHeight: 1080, measure,
    });
    expect(l.backgroundRect).toMatchObject({ left: -20 - 20 + 5, width: 40 + 40, top: l.textRect.top - 40, height: l.textRect.height + 80 });
    expect(l.backgroundRadius).toBeCloseTo(Math.min(l.backgroundRect!.width, l.backgroundRect!.height) / 2);
    expect(l.visualRect.width).toBeGreaterThanOrEqual(l.textRect.width);
  });
  it("no background box unless enabled", () => {
    expect(layoutText({ params: TEXT_DEFAULTS, canvasHeight: 1080, measure }).backgroundRect).toBeNull();
  });
});

describe("shape geometry", () => {
  it("polygon first vertex points up and vertices lie on the circle", () => {
    const v = polygonVertices({ sides: 5, cx: 100, cy: 100, radius: 50 });
    expect(v).toHaveLength(5);
    expect(v[0]!.x).toBeCloseTo(100);
    expect(v[0]!.y).toBeCloseTo(50);
    for (const p of v) expect(Math.hypot(p.x - 100, p.y - 100)).toBeCloseTo(50);
  });
  it("star alternates outer and inner radius by depth", () => {
    const v = starVertices({ points: 5, cx: 0, cy: 0, radius: 100, depth: 45 });
    expect(v).toHaveLength(10);
    expect(Math.hypot(v[0]!.x, v[0]!.y)).toBeCloseTo(100);
    expect(Math.hypot(v[1]!.x, v[1]!.y)).toBeCloseTo(45);
  });
});

describe("mask geometry", () => {
  it("rectangle covers width/height fractions around the offset centre", () => {
    const s = maskShape("rectangle", { centerX: 0.1, centerY: 0, width: 0.5, height: 0.5, rotation: 0 }, 200, 100);
    if (s.kind !== "polygon") throw new Error("polygon expected");
    const xs = s.points.map((p) => p.x);
    const ys = s.points.map((p) => p.y);
    expect(Math.min(...xs)).toBeCloseTo(20 - 50);
    expect(Math.max(...xs)).toBeCloseTo(20 + 50);
    expect(Math.min(...ys)).toBeCloseTo(-25);
    expect(Math.max(...ys)).toBeCloseTo(25);
  });
  it("rotation rotates about the mask centre", () => {
    const s = maskShape("rectangle", { width: 0.5, height: 0.2, rotation: 90 }, 100, 100);
    if (s.kind !== "polygon") throw new Error("polygon expected");
    const xs = s.points.map((p) => p.x);
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(20);
  });
  it("star has ten vertices, cinematic bars always span the element, ellipse radii are half the box", () => {
    const star = maskShape("star", { width: 0.6, height: 0.6 }, 100, 100);
    expect(star.kind === "polygon" && star.points.length).toBe(10);
    const bars = maskShape("cinematic-bars", { width: 0.1, height: 0.5 }, 100, 50);
    if (bars.kind !== "polygon") throw new Error("polygon expected");
    expect(Math.max(...bars.points.map((p) => p.x)) - Math.min(...bars.points.map((p) => p.x))).toBeGreaterThanOrEqual(100);
    const ellipse = maskShape("ellipse", { width: 0.5, height: 0.25 }, 200, 100);
    expect(ellipse).toMatchObject({ kind: "ellipse", rx: 50, ry: 12.5 });
  });
  it("tiny sizes are floored so masks never collapse to nothing", () => {
    const s = maskShape("ellipse", { width: 0, height: 0 }, 100, 100);
    expect(s).toMatchObject({ rx: 0.5, ry: 0.5 });
  });
});

describe("blend modes", () => {
  it("every blend mode maps to a canvas composite operation", () => {
    for (const mode of BLEND_MODES) expect(typeof compositeOperation(mode)).toBe("string");
    expect(compositeOperation("normal")).toBe("source-over");
    expect(compositeOperation("plus-lighter")).toBe("lighter");
  });
});
