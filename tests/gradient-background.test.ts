import { describe, expect, it } from "vitest";
import { updateSettings } from "#/engine/commands";
import type { GradientBackground } from "#/engine/model";
import { DEFAULT_GRADIENT, activeGradient, buildFramePlan, gradientAngleAt, gradientBlobs, gradientProblem, linearGradientLine, radialCenter, rgba } from "#/engine/render";
import { deserializeProject, serializeProject } from "#/engine/persistence";
import { setupAgent } from "./agent-harness";
import { makeEditor, sec, tracksWith } from "./helpers";

const mesh: GradientBackground = { type: "gradient", style: "mesh", colors: ["#0f172a", "#7c3aed", "#06b6d4"], angle: 0, motion: 50 };

describe("gradient maths", () => {
  it("spans the box exactly for any angle", () => {
    const up = linearGradientLine({ width: 200, height: 100, angle: 0 });
    expect([up.x0, up.y0, up.x1, up.y1].map(Math.round)).toEqual([100, 100, 100, 0]);
    const right = linearGradientLine({ width: 200, height: 100, angle: 90 });
    expect([right.x0, right.y0, right.x1, right.y1].map(Math.round)).toEqual([0, 50, 200, 50]);
    const diagonal = linearGradientLine({ width: 100, height: 100, angle: 135 });
    expect(diagonal.x0).toBeCloseTo(0, 6);
    expect(diagonal.y0).toBeCloseTo(0, 6);
    expect(diagonal.x1).toBeCloseTo(100, 6);
    expect(diagonal.y1).toBeCloseTo(100, 6);
  });
  it("holds still with no motion and moves smoothly with it", () => {
    const at = (motion: number, seconds: number) => gradientBlobs({ colors: mesh.colors, motion, seconds });
    expect(at(0, 0)).toEqual(at(0, 37));
    expect(gradientAngleAt({ ...mesh, motion: 0, angle: 20 }, 9)).toBe(20);
    expect(radialCenter({ motion: 0, seconds: 5 })).toEqual({ x: 0.5, y: 0.5 + 0.12 });
    const a = at(50, 1);
    const b = at(50, 1 + 1 / 30);
    a.forEach((blob, i) => {
      expect(Math.hypot(blob.x - (b[i]?.x ?? 0), blob.y - (b[i]?.y ?? 0))).toBeLessThan(0.02);
    });
    expect(at(50, 3)).not.toEqual(at(50, 0));
    for (const blob of at(100, 123.4)) {
      expect(blob.x).toBeGreaterThan(0);
      expect(blob.x).toBeLessThan(1);
    }
  });
  it("is deterministic: the same time always gives the same picture", () => {
    expect(gradientBlobs({ colors: mesh.colors, motion: 80, seconds: 4.2 })).toEqual(gradientBlobs({ colors: mesh.colors, motion: 80, seconds: 4.2 }));
  });
  it("converts hex to rgba", () => {
    expect(rgba("#ff8000", 0.5)).toBe("rgba(255,128,0,0.5)");
  });
});

describe("gradient validation", () => {
  it("accepts good gradients and explains bad ones", () => {
    expect(gradientProblem(DEFAULT_GRADIENT)).toBeNull();
    expect(gradientProblem(mesh)).toBeNull();
    expect(gradientProblem(null)).toMatch(/object/);
    expect(gradientProblem({ ...mesh, style: "conic" })).toMatch(/style/);
    expect(gradientProblem({ ...mesh, colors: ["#000000"] })).toMatch(/2 to 6/);
    expect(gradientProblem({ ...mesh, colors: Array(7).fill("#000000") })).toMatch(/2 to 6/);
    expect(gradientProblem({ ...mesh, colors: ["#000000", "red"] })).toMatch(/#rrggbb/);
    expect(gradientProblem({ ...mesh, angle: Number.NaN })).toMatch(/angle/);
    expect(gradientProblem({ ...mesh, motion: 101 })).toMatch(/motion/);
  });
  it("only trusts a valid gradient when planning a frame", () => {
    expect(activeGradient(mesh)).toEqual(mesh);
    expect(activeGradient({ type: "gradient", style: "mesh", colors: "nope" } as never)).toBeNull();
    expect(activeGradient({ type: "color", color: "#fff" })).toBeNull();
  });
});

describe("gradient background in the editor", () => {
  const plan = (background: Parameters<typeof buildFramePlan>[0]["background"]) =>
    buildFramePlan({ tracks: tracksWith({}), canvas: { width: 1920, height: 1080 }, background, assets: [], time: sec(2) });

  it("reaches the frame plan with no solid colour, and colour backgrounds carry no gradient", () => {
    expect(plan(mesh)).toMatchObject({ backgroundColor: null, backgroundGradient: mesh });
    expect(plan({ type: "color", color: "#101010" })).toMatchObject({ backgroundColor: "#101010", backgroundGradient: null });
    expect(plan({ type: "blur", blurIntensity: 10 }).backgroundGradient).toBeNull();
  });
  it("is set through updateSettings in one undo step, rejects a damaged one, and survives save and load", () => {
    const { editor } = makeEditor();
    editor.execute(updateSettings({ background: mesh }));
    expect(editor.getState().doc.settings.background).toEqual(mesh);
    expect(() => editor.execute(updateSettings({ background: { ...mesh, colors: ["#fff"] } }))).toThrow(/gradient/i);
    expect(deserializeProject(serializeProject(editor.toProject())).settings.background).toEqual(mesh);
    editor.undo();
    expect(editor.getState().doc.settings.background.type).toBe("color");
  });
  it("set_project accepts a gradient with defaults for what is left out, and refuses mixing or bad input", async () => {
    const h = setupAgent();
    await h.data("set_project", { backgroundGradient: { style: "radial", colors: ["#111111", "#2222ee"] } });
    expect(h.editor.getState().doc.settings.background).toEqual({ ...DEFAULT_GRADIENT, style: "radial", colors: ["#111111", "#2222ee"] });
    expect((await h.failure("set_project", { backgroundGradient: { colors: ["#111111"] } })).error).toContain("2 to 6");
    expect((await h.failure("set_project", { backgroundGradient: { style: "mesh" }, backgroundColor: "#000000" })).error).toContain("only one");
    expect(h.editor.getState().doc.settings.background.type).toBe("gradient");
  });
});
