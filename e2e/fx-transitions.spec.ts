import { expect, test, type Page } from "@playwright/test";
import { near, openFxHarness, savePng, type Rgb } from "./fx-support";

/** Blur, flash and glitch transitions between two flat image clips, in the preview compositor and in the export. */
async function twoClips(page: Page, type: string): Promise<void> {
  await openFxHarness(page, [{ id: "red", color: "#e11d48", pattern: "halves" }, { id: "blue", color: "#2563eb", pattern: "halves" }]);
  await page.evaluate((transition) => {
    const { editor, mods } = window.__fx;
    const { commands, time } = mods;
    const main = editor.tracks().main.id;
    const place = (id: string, assetId: string, start: number) => {
      const asset = editor.getAsset(assetId)!;
      editor.execute(commands.insertMediaElement({ asset, elementId: id, startTime: time.mediaTimeFromSeconds(start), placement: { mode: "explicit", trackId: main } }));
      editor.execute(commands.updateElements([{ ref: { trackId: main, elementId: id }, patch: { duration: time.mediaTimeFromSeconds(4) } }]));
    };
    place("a", "red", 0);
    place("b", "blue", 4);
    editor.execute(commands.setTransitionCommand({ ref: { trackId: main, elementId: "b" }, transition: { type: transition as never, duration: time.mediaTimeFromSeconds(1) } }));
  }, type);
}

test("flash washes the cut out to white and comes back to the next clip", async ({ page }) => {
  await twoClips(page, "flash");
  const sample = (t: number) => page.evaluate((s) => window.__fx.pixelsAt(s, [[200, 540]]), t);
  const before = await sample(0.5);
  const atCut = await sample(4.0);
  const after = await sample(4.9);
  expect(near(before?.[0] as Rgb, [225, 29, 72], 6)).toBe(true);
  expect(near(atCut?.[0] as Rgb, [255, 255, 255], 12), `at the cut ${String(atCut?.[0])}`).toBe(true);
  expect(near(after?.[0] as Rgb, [37, 99, 235], 6)).toBe(true);
  const exported = await page.evaluate(() => window.__fx.exportPixels({ times: [3.99, 4.0], points: [[200, 540]] }));
  expect((exported[0]?.[0] as Rgb)[0]).toBeGreaterThan(240);
});

test("blur softens the hard edge in both clips while they cross-fade", async ({ page }) => {
  await twoClips(page, "blur");
  const edge: [number, number][] = [[955, 540], [965, 540]];
  const contrast = (px: Rgb[]): number => Math.abs((px[0] as Rgb)[1] - (px[1] as Rgb)[1]);
  const blurred = contrast(await page.evaluate((p) => window.__fx.pixelsAt(4.0, p), edge));
  await page.evaluate(() => {
    const { editor, mods } = window.__fx;
    editor.execute(mods.commands.setTransitionCommand({ ref: { trackId: editor.tracks().main.id, elementId: "b" }, transition: { type: "dissolve", duration: mods.time.mediaTimeFromSeconds(1) } }));
  });
  const sharp = contrast(await page.evaluate((p) => window.__fx.pixelsAt(4.0, p), edge));
  expect(sharp, "a plain dissolve keeps the hard edge").toBeGreaterThan(100);
  expect(blurred, "the blur transition softens it").toBeLessThan(sharp * 0.7);
  await page.evaluate(() => {
    const { editor, mods } = window.__fx;
    editor.execute(mods.commands.setTransitionCommand({ ref: { trackId: editor.tracks().main.id, elementId: "b" }, transition: { type: "blur", duration: mods.time.mediaTimeFromSeconds(1) } }));
  });
  savePng("transition-blur", await page.evaluate(() => window.__fx.pngAt(3.95)));
  const exported = await page.evaluate((p) => window.__fx.exportPixels({ times: [4.0], points: p }), edge);
  expect(contrast(exported[0] as Rgb[]), "the export softens it too").toBeLessThan(sharp * 0.8);
});

test("glitch slides slices sideways mid-transition and is clean outside it", async ({ page }) => {
  await twoClips(page, "glitch");
  const column: [number, number][] = Array.from({ length: 24 }, (_, i) => [945, 20 + i * 44]);
  const clean = await page.evaluate((p) => window.__fx.pixelsAt(0.5, p), column);
  expect(new Set(clean.map((c) => c.join())).size, "before the window every row looks the same").toBe(1);
  const glitched = await page.evaluate((p) => window.__fx.pixelsAt(3.75, p), column);
  expect(new Set(glitched.map((c) => c.join())).size, "slices shift the hard edge in or out of view").toBeGreaterThan(1);
  const again = await page.evaluate((p) => window.__fx.pixelsAt(3.75, p), column);
  expect(again, "the same time draws the same glitch").toEqual(glitched);
  savePng("transition-glitch", await page.evaluate(() => window.__fx.pngAt(3.75)));
});
