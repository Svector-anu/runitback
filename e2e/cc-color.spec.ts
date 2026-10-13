import { expect, test, type Page } from "@playwright/test";
import { callAgentTool, near, openCcHarness, savePng, type Point, type Rgb } from "./cc-support";

test.use({ channel: "chrome" });

const CENTER: Point = [160, 90];
const CORNER: Point = [4, 4];
const GRAY = "#646464";

const sample = (page: Page, points: Point[], seconds = 1): Promise<Rgb[]> => page.evaluate(({ seconds, points }) => window.__cc.renderAt(seconds, points), { seconds, points });
const shot = (page: Page, name: string): Promise<void> => page.evaluate(() => window.__cc.pngAt(1)).then((url) => savePng(name, url));
const clipId = "clip-0";

async function adjust(page: Page, params: Record<string, number>): Promise<void> {
  const r = await callAgentTool(page, "set_color_adjust", { elementIds: [clipId], params });
  expect(r.ok, r.error).toBe(true);
}

test("brightness, exposure and contrast move pixels the expected way", async ({ page }) => {
  await openCcHarness(page, [{ color: GRAY, seconds: 3 }]);
  const [base] = await sample(page, [CENTER]);
  expect(near(base as Rgb, [100, 100, 100], 12)).toBe(true);
  await adjust(page, { brightness: 50 });
  const [bright] = await sample(page, [CENTER]);
  expect(bright![0]).toBeGreaterThan(base![0] + 35);
  await adjust(page, { brightness: 0, exposure: -50 });
  const [dark] = await sample(page, [CENTER]);
  expect(dark![0]).toBeLessThan(base![0] - 30);
});

test("mono removes saturation; vivid increases it", async ({ page }) => {
  await openCcHarness(page, [{ color: "#c86432", seconds: 3 }]);
  const spread = (c: Rgb): number => Math.max(...c) - Math.min(...c);
  const [base] = await sample(page, [CENTER]);
  await callAgentTool(page, "apply_filter", { elementIds: [clipId], filter: "mono" });
  const [mono] = await sample(page, [CENTER]);
  expect(spread(mono as Rgb)).toBeLessThan(20);
  expect(spread(base as Rgb)).toBeGreaterThan(100);
  await callAgentTool(page, "apply_filter", { elementIds: [clipId], filter: "vivid" });
  const [vivid] = await sample(page, [CENTER]);
  expect(spread(vivid as Rgb)).toBeGreaterThan(spread(base as Rgb));
});

test("warm shifts toward red, cool toward blue, on a neutral grey", async ({ page }) => {
  await openCcHarness(page, [{ color: GRAY, seconds: 3 }]);
  await callAgentTool(page, "apply_filter", { elementIds: [clipId], filter: "warm" });
  const [warm] = (await sample(page, [CENTER])) as [Rgb];
  expect(warm[0]).toBeGreaterThan(warm[2] + 20);
  await callAgentTool(page, "apply_filter", { elementIds: [clipId], filter: "cool" });
  const [cool] = (await sample(page, [CENTER])) as [Rgb];
  expect(cool[2]).toBeGreaterThan(cool[0] + 20);
});

test("vignette darkens the corners and leaves the centre", async ({ page }) => {
  await openCcHarness(page, [{ color: GRAY, seconds: 3 }]);
  await adjust(page, { vignette: 100 });
  const [centre, corner] = (await sample(page, [CENTER, CORNER])) as [Rgb, Rgb];
  expect(near(centre, [100, 100, 100], 12)).toBe(true);
  expect(corner[0]).toBeLessThan(centre[0] - 40);
});

test("sharpen exaggerates a hard edge", async ({ page }) => {
  await openCcHarness(page, [{ color: "#000000", seconds: 3, pattern: "halves" }]);
  const edge: Point[] = [[158, 90], [161, 90]];
  const [darkSide, lightSide] = (await sample(page, edge)) as [Rgb, Rgb];
  await adjust(page, { sharpen: 100 });
  const [darkAfter, lightAfter] = (await sample(page, edge)) as [Rgb, Rgb];
  // The blur kernel differs between GPU and software rasterizers, so assert the direction on each side and the
  // gain in edge contrast relative to this run's own unsharpened baseline, not absolute pixel values.
  expect(darkAfter[0]).toBeLessThan(darkSide[0]);
  expect(lightAfter[0]).toBeGreaterThan(lightSide[0]);
  expect(lightAfter[0] - darkAfter[0]).toBeGreaterThanOrEqual(lightSide[0] - darkSide[0] + 8);
  const [far] = (await sample(page, [[40, 90]])) as [Rgb];
  expect(near(far, [64, 64, 64], 10)).toBe(true);
});

test("a scene-wide adjust layer colours everything below it", async ({ page }) => {
  await openCcHarness(page, [{ color: "#c86432", seconds: 3 }]);
  const layer = await callAgentTool(page, "insert_effect_layer", { effectType: "adjust", start: 0, duration: 3, params: { saturation: -100 } });
  expect(layer.ok, layer.error).toBe(true);
  const [px] = (await sample(page, [CENTER])) as [Rgb];
  expect(Math.max(...px) - Math.min(...px)).toBeLessThan(20);
});

test("all eight filters render distinct looks (screenshots) and export matches the preview", async ({ page }) => {
  await openCcHarness(page, [{ color: "#808080", seconds: 3, pattern: "bands" }]);
  const seen = new Set<string>();
  for (const filter of ["vivid", "mono", "warm", "cool", "fade", "noir", "teal-orange", "sepia"]) {
    const r = await callAgentTool(page, "apply_filter", { elementIds: [clipId], filter });
    expect(r.ok, r.error).toBe(true);
    const [a, b, c, d] = (await sample(page, [[40, 90], [120, 90], [200, 90], [280, 90]])) as Rgb[];
    seen.add(JSON.stringify([a, b, c, d]));
    await shot(page, `filter-${filter}`);
  }
  expect(seen.size).toBe(8);
  await callAgentTool(page, "apply_filter", { elementIds: [clipId], filter: "mono" });
  const preview = (await sample(page, [[40, 90]], 1))[0] as Rgb;
  const out = await page.evaluate(() => window.__cc.exportAt({ times: [1], points: [[40, 90]] }));
  expect(near(out.samples[0]![0] as Rgb, preview, 30)).toBe(true);
  expect(Math.max(...(out.samples[0]![0] as Rgb)) - Math.min(...(out.samples[0]![0] as Rgb))).toBeLessThan(25);
});
