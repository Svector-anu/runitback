import { expect, test } from "@playwright/test";
import { near, openFxHarness, savePng, type Rgb } from "./fx-support";

/** Gradient canvas backgrounds: the compositor paints them under every layer, they drift with time, and the export matches. */
test.describe("gradient background", () => {
  const setGradient = (page: import("@playwright/test").Page, background: object) =>
    page.evaluate((bg) => {
      const { editor, mods } = window.__fx;
      editor.execute(mods.commands.updateSettings({ background: bg as never }));
      const seconds = (s: number) => mods.time.mediaTimeFromSeconds(s);
      const probe = mods.model.buildGraphicElement({ id: "probe", startTime: seconds(0), definitionId: "ellipse", params: { fill: "#ffffff", "transform.scaleX": 0.1, "transform.scaleY": 0.1 } });
      editor.execute(mods.commands.insertElement({ element: { ...probe, duration: seconds(10) }, placement: { mode: "newTrack", index: 0, trackId: "probe" } }));
    }, background);

  test("a linear gradient runs from its first colour to its last", async ({ page }) => {
    await openFxHarness(page);
    await setGradient(page, { type: "gradient", style: "linear", colors: ["#ff0000", "#0000ff"], angle: 90, motion: 0 });
    const [left, right, middle] = await page.evaluate(() => window.__fx.pixelsAt(0, [[4, 100], [1915, 100], [700, 100]]));
    expect(near(left as Rgb, [255, 0, 0], 12), `left ${String(left)}`).toBe(true);
    expect(near(right as Rgb, [0, 0, 255], 12), `right ${String(right)}`).toBe(true);
    expect((middle as Rgb)[0]).toBeGreaterThan(80);
    expect((middle as Rgb)[2]).toBeGreaterThan(80);
    const exported = await page.evaluate(() => window.__fx.exportPixels({ times: [0.5], points: [[4, 100], [1915, 100]] }));
    expect(near(exported[0]?.[0] as Rgb, [255, 0, 0], 40)).toBe(true);
    expect(near(exported[0]?.[1] as Rgb, [0, 0, 255], 40)).toBe(true);
  });

  test("a mesh drifts with motion and holds still without it", async ({ page }) => {
    await openFxHarness(page);
    await setGradient(page, { type: "gradient", style: "mesh", colors: ["#0f172a", "#7c3aed", "#06b6d4", "#f43f5e"], angle: 0, motion: 80 });
    const grid: [number, number][] = [[200, 200], [1700, 200], [200, 900], [1700, 900], [960, 300]];
    const first = await page.evaluate((g) => window.__fx.pixelsAt(0, g), grid);
    const later = await page.evaluate((g) => window.__fx.pixelsAt(4, g), grid);
    const moved = first.reduce((sum, c, i) => sum + Math.abs(c[0] - (later[i]?.[0] ?? 0)) + Math.abs(c[1] - (later[i]?.[1] ?? 0)) + Math.abs(c[2] - (later[i]?.[2] ?? 0)), 0);
    expect(moved, "the mesh colours shift over four seconds").toBeGreaterThan(60);
    savePng("mesh-0s", await page.evaluate(() => window.__fx.pngAt(0)));
    savePng("mesh-4s", await page.evaluate(() => window.__fx.pngAt(4)));
    await page.evaluate(() => window.__fx.editor.execute(window.__fx.mods.commands.updateSettings({ background: { type: "gradient", style: "mesh", colors: ["#0f172a", "#7c3aed", "#06b6d4", "#f43f5e"], angle: 0, motion: 0 } })));
    const still = await page.evaluate((g) => window.__fx.pixelsAt(0, g), grid);
    const stillLater = await page.evaluate((g) => window.__fx.pixelsAt(4, g), grid);
    expect(stillLater).toEqual(still);
  });
});
