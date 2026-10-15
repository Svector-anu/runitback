import { expect, test, type Page } from "@playwright/test";
import { openFxHarness, savePng, type Rgb } from "./fx-support";

/** Blur-in, per-word stagger, typing caret, word highlight and count-up, through the shared compositor and the exporter. */
const REGION: [number, number, number, number] = [360, 380, 1200, 320];

async function addText(page: Page, params: Record<string, number | string | boolean>, animation?: { preset: string; seconds: number }): Promise<void> {
  await openFxHarness(page);
  await page.evaluate(({ params, animation }) => {
    const { editor, mods } = window.__fx;
    const { model, commands, time } = mods;
    const base = model.buildTextElement({ id: "t", startTime: 0 as never });
    const element = { ...base, duration: time.mediaTimeFromSeconds(6), params: { ...base.params, "fontSize": 14, "fontWeight": "bold", ...params } };
    editor.execute(commands.insertElement({ element, placement: { mode: "newTrack", index: 0, trackId: "txt" } }));
    if (animation) editor.execute(commands.setTextAnimationCommand({ ref: { trackId: "txt", elementId: "t" }, in: { preset: animation.preset as never, duration: time.mediaTimeFromSeconds(animation.seconds) } }));
  }, { params, animation });
}
const mean = (page: Page, seconds: number): Promise<Rgb> => page.evaluate(({ s, r }) => window.__fx.meanAt(s, r), { s: seconds, r: REGION });
const luma = (c: Rgb): number => (c[0] + c[1] + c[2]) / 3;

test("blur-in starts as a soft glow and sharpens into the finished text", async ({ page }) => {
  await addText(page, { content: "Launch day" }, { preset: "blur-in", seconds: 1 });
  const early = await page.evaluate((r) => window.__fx.peakAt(0.05, r), REGION);
  const settled = await page.evaluate((r) => window.__fx.peakAt(2, r), REGION);
  expect(luma(early), "a blurred, mostly transparent start is dim").toBeLessThan(luma(settled) * 0.6);
  expect(luma(settled)).toBeGreaterThan(240);
  savePng("text-blur-in-early", await page.evaluate(() => window.__fx.pngAt(0.3)));
  const [exported] = await page.evaluate((r) => window.__fx.exportMeans({ times: [2], rect: r }), REGION);
  const preview = await mean(page, 2);
  expect(Math.abs(luma(exported as Rgb) - luma(preview))).toBeLessThan(10);
});

test("per-word stagger brings the words in one after another", async ({ page }) => {
  await addText(page, { content: "one two three four" }, { preset: "stagger-words", seconds: 2 });
  const levels: number[] = [];
  for (const t of [0, 0.5, 1, 1.5, 2.1]) levels.push(luma(await mean(page, t)));
  expect(levels[0]).toBeLessThan(2);
  for (let i = 1; i < levels.length; i++) expect(levels[i], `level at step ${i}: ${levels.join(", ")}`).toBeGreaterThan((levels[i - 1] as number) - 0.5);
  expect(levels[4]).toBeGreaterThan((levels[1] as number) * 1.5);
  savePng("text-stagger-mid", await page.evaluate(() => window.__fx.pngAt(1)));
});

test("the typing caret is solid while typing and blinks once the text is complete", async ({ page }) => {
  await addText(page, { content: "typed", caret: true }, { preset: "type-caret", seconds: 1 });
  const startOfType = await mean(page, 0);
  expect(luma(startOfType), "a solid caret shows before the first letter").toBeGreaterThan(0.2);
  const on = luma(await mean(page, 2.25));
  const off = luma(await mean(page, 2.75));
  expect(on, "caret on at 0.25 s of the blink cycle").toBeGreaterThan(off);
  savePng("text-caret-on", await page.evaluate(() => window.__fx.pngAt(2.25)));
});

test("the highlighted word takes the highlight colour and nothing else does", async ({ page }) => {
  await addText(page, { content: "ship it today", highlightWord: 1, highlightColor: "#ff0000" });
  const [r, g] = await mean(page, 1);
  expect(r, "red from the highlighted word on top of the white text").toBeGreaterThan(g + 1.5);
  await page.evaluate(() => {
    const { editor, mods } = window.__fx;
    editor.execute(mods.commands.updateElements([{ ref: { trackId: "txt", elementId: "t" }, patch: { params: { highlightWord: -1 } } }]));
  });
  const [r2, g2] = await mean(page, 1);
  expect(Math.abs(r2 - g2)).toBeLessThan(0.5);
});

test("a count-up number grows from zero to its target", async ({ page }) => {
  await addText(page, { content: "$12,400+" }, { preset: "count-up", seconds: 2 });
  const start = luma(await mean(page, 0));
  const middle = luma(await mean(page, 0.5));
  const end = luma(await mean(page, 2.5));
  expect(start).toBeLessThan(middle);
  expect(middle).toBeLessThan(end);
  savePng("text-count-end", await page.evaluate(() => window.__fx.pngAt(2.5)));
  const [exported] = await page.evaluate((r) => window.__fx.exportMeans({ times: [2.5], rect: r }), REGION);
  expect(Math.abs(luma(exported as Rgb) - end)).toBeLessThan(10);
});
