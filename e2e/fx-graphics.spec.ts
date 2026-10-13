import { expect, test } from "@playwright/test";
import { callAgentTool, near, openFxHarness, savePng, type Rgb } from "./fx-support";

/** Cursor with click ripple and the window frame: drawn at their laid-out size, identical in the preview compositor and the exporter. */
test.describe("cursor and window frame", () => {
  test.beforeEach(async ({ page }) => {
    await openFxHarness(page);
    await page.evaluate(() => {
      const { editor, mods } = window.__fx;
      const { model, commands } = mods;
      const seconds = (s: number) => mods.time.mediaTimeFromSeconds(s);
      const backdrop = model.buildGraphicElement({ id: "backdrop", startTime: seconds(0), definitionId: "rectangle", params: { fill: "#1e1b4b", "transform.scaleX": 2, "transform.scaleY": 1.1 } });
      editor.execute(commands.insertElement({ element: { ...backdrop, duration: seconds(4) }, placement: { mode: "newTrack", index: 0, trackId: "bg" } }));
      const defaults = model.defaultsOf(model.GRAPHIC_DEFINITIONS["window-frame"]!.params);
      const frame = model.buildGraphicElement({ id: "frame", startTime: seconds(0), definitionId: "window-frame", params: { ...defaults, style: "mac", "transform.scaleX": 1.2, "transform.scaleY": 0.7 } });
      editor.execute(commands.insertElement({ element: { ...frame, duration: seconds(4) }, placement: { mode: "newTrack", index: 0, trackId: "frame" } }));
    });
    const cursor = await callAgentTool(page, "insert_cursor", {
      points: [{ time: 0, x: -400, y: 200 }, { time: 1, x: 100, y: -50, click: true }, { time: 3, x: 100, y: -50 }], start: 0, newTrack: true,
    });
    expect(cursor.ok, cursor.error).toBe(true);
  });

  test("the frame draws its chrome undistorted and the cursor sits on its waypoint", async ({ page }) => {
    const [bar, light, body, outside] = await page.evaluate(() => window.__fx.pixelsAt(0, [[900, 185], [334, 185], [900, 700], [100, 100]]));
    expect(near(bar as Rgb, [236, 236, 241], 8), `bar ${String(bar)}`).toBe(true);
    expect(near(light as Rgb, [255, 95, 87], 30), `traffic light ${String(light)}`).toBe(true);
    expect(near(body as Rgb, [255, 255, 255], 4)).toBe(true);
    expect(near(outside as Rgb, [30, 27, 75], 6)).toBe(true);
    const around = await page.evaluate(() => window.__fx.meanAt(0, [556, 736, 44, 60]));
    const away = await page.evaluate(() => window.__fx.meanAt(0.5, [556, 736, 44, 60]));
    expect(away[0] - around[0], "the pointer draws dark outline pixels at its start").toBeGreaterThan(6);
    savePng("cursor-start", await page.evaluate(() => window.__fx.pngAt(0)));
  });

  test("the click ripple tints the page around the hotspot only while it plays, in preview and in the export", async ({ page }) => {
    const probe: [number, number][] = [[1060, 440]];
    const [before] = await page.evaluate((p) => window.__fx.pixelsAt(1.0, p), probe);
    const [during] = await page.evaluate((p) => window.__fx.pixelsAt(1.15, p), probe);
    const [after] = await page.evaluate((p) => window.__fx.pixelsAt(2, p), probe);
    expect(near(before as Rgb, [255, 255, 255], 4)).toBe(true);
    expect((during as Rgb)[2] - (during as Rgb)[0], `ripple tint ${String(during)}`).toBeGreaterThan(12);
    expect(near(after as Rgb, [255, 255, 255], 4)).toBe(true);
    savePng("cursor-click", await page.evaluate(() => window.__fx.pngAt(1.15)));
    const exported = await page.evaluate((p) => window.__fx.exportPixels({ times: [1.15, 2], points: p }), probe);
    const tint = (frame: Rgb[] | undefined): number => ((frame?.[0] as Rgb)[2]) - ((frame?.[0] as Rgb)[0]);
    expect(tint(exported[0]) - tint(exported[1]), `exported ${String(exported[0])} vs ${String(exported[1])}`).toBeGreaterThan(4);
  });
});
