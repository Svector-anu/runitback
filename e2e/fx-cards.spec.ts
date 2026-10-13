import { expect, test, type Page } from "@playwright/test";
import { near, openFxHarness, savePng, type Rgb } from "./fx-support";

/** Perspective tilt, rounded image cards and drop shadows: drawn by the shared compositor, so the export matches the preview. */
async function placeImage(page: Page, input: { scale: number; params?: Record<string, number>; background?: string }): Promise<void> {
  await page.evaluate(({ scale, params, background }) => {
    const { editor, mods } = window.__fx;
    const { commands, time } = mods;
    const main = editor.tracks().main.id;
    const asset = editor.getAsset("card")!;
    editor.execute(commands.insertMediaElement({ asset, elementId: "card", startTime: 0 as never, placement: { mode: "explicit", trackId: main } }));
    editor.execute(commands.updateElements([{ ref: { trackId: main, elementId: "card" }, patch: { duration: time.mediaTimeFromSeconds(4), params: { "transform.scaleX": scale, "transform.scaleY": scale, ...params } } }]));
    editor.execute(commands.updateSettings({ background: { type: "color", color: background ?? "#000000" } }));
  }, { scale: input.scale, params: input.params ?? {}, background: input.background });
}

/** Rows (of a 1080 frame) in column `x` that differ from the background, scanned every 3 px. */
async function verticalExtent(page: Page, x: number, background: Rgb): Promise<number> {
  const points: [number, number][] = Array.from({ length: 360 }, (_, i) => [x, i * 3]);
  const pixels = await page.evaluate((p) => window.__fx.pixelsAt(0.5, p), points);
  return pixels.filter((px) => !near(px, background, 24)).length * 3;
}

test("a tilted card keeps its near edge tall and its far edge short, in the preview and the export", async ({ page }) => {
  await openFxHarness(page, [{ id: "card", color: "#e11d48", pattern: "grid" }]);
  await placeImage(page, { scale: 0.5, params: { "transform.rotateY": 40 } });
  const leftEdge = await verticalExtent(page, 560, [0, 0, 0]);
  const rightEdge = await verticalExtent(page, 1240, [0, 0, 0]);
  expect(leftEdge, `left ${leftEdge} px tall, right ${rightEdge} px tall`).toBeGreaterThan(rightEdge + 40);
  expect(rightEdge).toBeGreaterThan(300);
  savePng("tilt-y40", await page.evaluate(() => window.__fx.pngAt(0.5)));

  await page.evaluate(() => {
    const { editor, mods } = window.__fx;
    editor.execute(mods.commands.updateElements([{ ref: { trackId: editor.tracks().main.id, elementId: "card" }, patch: { params: { "transform.rotateY": 0, "transform.rotateX": 40 } } }]));
  });
  const topWide = await page.evaluate(() => window.__fx.meanAt(0.5, [500, 300, 900, 40]));
  const bottomWide = await page.evaluate(() => window.__fx.meanAt(0.5, [500, 740, 900, 40]));
  expect(topWide[0] + 1, "top edge is tipped away, so less of it covers the strip").not.toBe(bottomWide[0] + 1);
  const exported = await page.evaluate(() => window.__fx.exportMeans({ times: [0.5], rect: [500, 300, 900, 40] }));
  expect(Math.abs((exported[0] as Rgb)[0] - topWide[0])).toBeLessThan(40);
  savePng("tilt-x40", await page.evaluate(() => window.__fx.pngAt(0.5)));
});

test("a rounded mask clips the corners and the drop shadow follows the rounded outline", async ({ page }) => {
  await openFxHarness(page, [{ id: "card", color: "#2563eb", pattern: "solid" }]);
  await placeImage(page, { scale: 0.5, background: "#ffffff" });
  await page.evaluate(() => {
    const { editor, mods } = window.__fx;
    const ref = { trackId: editor.tracks().main.id, elementId: "card" };
    editor.execute(mods.commands.addMask(ref, "rectangle"));
    const mask = (editor.tracks().main.elements[0] as { masks?: Array<{ id: string }> }).masks![0]!;
    editor.execute(mods.commands.updateMaskParams(ref, mask.id, { width: 1, height: 1, cornerRadius: 30 }));
    editor.execute(mods.commands.addClipEffect({ ref, effectType: "shadow" }));
  });
  const [centre, corner, below, farBelow] = await page.evaluate(() => window.__fx.pixelsAt(0.5, [[960, 540], [484, 274], [960, 822], [960, 1060]]));
  expect(near(centre as Rgb, [37, 99, 235], 8)).toBe(true);
  expect(near(corner as Rgb, [255, 255, 255], 30), `the clipped corner shows the page, got ${String(corner)}`).toBe(true);
  expect((below as Rgb)[0], "the shadow darkens the page just under the card").toBeLessThan((farBelow as Rgb)[0] - 12);
  savePng("card-shadow", await page.evaluate(() => window.__fx.pngAt(0.5)));
  const exported = await page.evaluate(() => window.__fx.exportPixels({ times: [0.5], points: [[484, 274], [960, 822], [960, 1060]] }));
  expect(near(exported[0]?.[0] as Rgb, [255, 255, 255], 40)).toBe(true);
  expect((exported[0]?.[1] as Rgb)[0]).toBeLessThan((exported[0]?.[2] as Rgb)[0] - 8);
});
