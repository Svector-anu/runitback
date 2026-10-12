import { expect, test, type Page } from "@playwright/test";
import { callAgentTool, openCcHarness, savePng, type PixelStats } from "./cc-support";

test.use({ channel: "chrome" });

const stats = (page: Page, seconds: number): Promise<PixelStats> => page.evaluate((s) => window.__cc.statsAt(s), seconds);
const shot = (page: Page, name: string, seconds: number): Promise<void> => page.evaluate((s) => window.__cc.pngAt(s), seconds).then((url) => savePng(name, url));

let titleId = "";
test.beforeEach(async ({ page }) => {
  await openCcHarness(page, [{ color: "#000000", seconds: 6 }]);
  const r = await callAgentTool(page, "insert_text", { text: "WAVE", start: 0, duration: 6 });
  expect(r.ok).toBe(true);
  titleId = (r.data as { elementId: string }).elementId;
  const big = await callAgentTool(page, "set_params", { elementId: titleId, params: { fontSize: 28, fontWeight: "bold" } });
  expect(big.ok).toBe(true);
});

test("a stroke adds outline pixels around the letters", async ({ page }) => {
  const before = await stats(page, 3);
  expect(before.white).toBeGreaterThan(200);
  expect(before.red).toBe(0);
  const r = await callAgentTool(page, "set_text_style", { elementIds: [titleId], stroke: { width: 3, color: "#ff0000" } });
  expect(r.ok, r.error).toBe(true);
  const after = await stats(page, 3);
  expect(after.red).toBeGreaterThan(300);
  expect(after.white).toBeGreaterThan(before.white * 0.7);
  await shot(page, "text-stroke", 3);
});

test("a drop shadow lands down-right of the text, in its own colour", async ({ page }) => {
  expect((await stats(page, 3)).blue).toBe(0);
  const r = await callAgentTool(page, "set_text_style", { elementIds: [titleId], shadow: { offsetX: 8, offsetY: 8, blur: 0, color: "#0000ff" } });
  expect(r.ok, r.error).toBe(true);
  expect((await stats(page, 3)).blue).toBeGreaterThan(200);
  await shot(page, "text-shadow", 3);
});

test("a background box paints behind the text", async ({ page }) => {
  const r = await callAgentTool(page, "set_text_style", { elementIds: [titleId], background: { color: "#ff0000", paddingX: 12, paddingY: 12, cornerRadius: 30 } });
  expect(r.ok, r.error).toBe(true);
  expect((await stats(page, 3)).red).toBeGreaterThan(2000);
  await shot(page, "text-background-box", 3);
});

test("fade in: invisible at the first frame, fully there after", async ({ page }) => {
  await callAgentTool(page, "set_text_animation", { elementIds: [titleId], in: { preset: "fade", duration: 1 } });
  expect((await stats(page, 0)).white).toBe(0);
  const half = (await stats(page, 0.2)).white;
  const full = (await stats(page, 2)).white;
  expect(full).toBeGreaterThan(200);
  expect(half).toBeLessThan(full);
});

test("slide-up rises into place; pop grows; typewriter reveals letter by letter", async ({ page }) => {
  await callAgentTool(page, "set_text_animation", { elementIds: [titleId], in: { preset: "slide-up", duration: 1 } });
  const early = await stats(page, 0.5);
  const settled = await stats(page, 2);
  expect(early.white).toBeGreaterThan(0);
  expect(early.whiteCentroidY).toBeGreaterThan(settled.whiteCentroidY + 3);

  await callAgentTool(page, "set_text_animation", { elementIds: [titleId], in: { preset: "pop", duration: 1 } });
  const small = await stats(page, 0.2);
  const grown = await stats(page, 2);
  expect(small.white).toBeLessThan(grown.white * 0.6);
  await shot(page, "text-pop-early", 0.2);

  await callAgentTool(page, "set_text_animation", { elementIds: [titleId], in: { preset: "typewriter", duration: 1 } });
  const counts = [(await stats(page, 0.0)).white, (await stats(page, 0.5)).white, (await stats(page, 1.5)).white];
  expect(counts[0]).toBe(0);
  expect(counts[1]).toBeGreaterThan(0);
  expect(counts[1]).toBeLessThan(counts[2] as number);
  await shot(page, "text-typewriter-half", 0.5);
});

test("export shows the stroke", async ({ page }) => {
  await callAgentTool(page, "set_text_style", { elementIds: [titleId], stroke: { width: 3, color: "#ff0000" } });
  const preview = await stats(page, 3);
  const out = await page.evaluate(() => window.__cc.exportAt({ times: [3], points: [[160, 90]], stats: true }));
  expect(out.stats?.[0]?.red).toBeGreaterThan(preview.red * 0.5);
});
