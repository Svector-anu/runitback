import { expect, test } from "@playwright/test";
import { openEditorWithClips, openPropertyTab, previewPixels, readElements, selectClip, setSlider, shot, spread, undo, type Rgb } from "./ctl-support";

test.use({ channel: "chrome" });

const CENTER: [number, number] = [0.5, 0.5];
const center = async (page: import("@playwright/test").Page): Promise<Rgb> => (await previewPixels(page, [CENTER]))[0] as Rgb;

test.beforeEach(async ({ page }) => {
  await openEditorWithClips(page, [{ name: "gray.webm", color: "#646464", seconds: 4 }]);
  await selectClip(page, 0);
  await openPropertyTab(page, "Adjust");
});

test("choosing Warm tints the preview; undo restores it in one step", async ({ page }) => {
  await expect.poll(async () => (await center(page))[0]).toBeGreaterThan(80);
  const before = await center(page);
  expect(spread(before)).toBeLessThan(12);

  await page.getByRole("button", { name: "Warm filter" }).click();
  await expect(page.getByRole("button", { name: "Warm filter" })).toHaveAttribute("aria-pressed", "true");
  await expect.poll(async () => { const c = await center(page); return c[0] - c[2]; }).toBeGreaterThan(15);
  await shot(page, "adjust-warm-panel", page.locator(".properties"));
  await shot(page, "adjust-warm-editor");

  await undo(page);
  await expect.poll(async () => spread(await center(page))).toBeLessThan(12);
  await expect(page.getByRole("button", { name: "Warm filter" })).toHaveAttribute("aria-pressed", "false");
  expect((await readElements(page))[0]?.effects ?? []).toHaveLength(0);
});

test("each preset is a distinct look; Cool reverses Warm; None clears the effect", async ({ page }) => {
  await page.getByRole("button", { name: "Warm filter" }).click();
  await expect.poll(async () => { const c = await center(page); return c[0] - c[2]; }).toBeGreaterThan(15);
  await page.getByRole("button", { name: "Cool filter" }).click();
  await expect.poll(async () => { const c = await center(page); return c[2] - c[0]; }).toBeGreaterThan(15);
  expect((await readElements(page))[0]?.effects).toHaveLength(1);
  await page.getByRole("button", { name: "Mono filter" }).click();
  await expect.poll(async () => spread(await center(page))).toBeLessThan(12);
  await page.getByRole("button", { name: "None filter" }).click();
  await expect.poll(async () => (await readElements(page))[0]?.effects ?? []).toHaveLength(0);
});

test("intensity scales the look and keeps the preset selected", async ({ page }) => {
  await page.getByRole("button", { name: "Warm filter" }).click();
  await expect.poll(async () => { const c = await center(page); return c[0] - c[2]; }).toBeGreaterThan(15);
  const full = await center(page);
  await setSlider(page, "Filter intensity slider", 0.3);
  await expect.poll(async () => { const c = await center(page); return c[0] - c[2]; }).toBeLessThan(full[0] - full[2] - 5);
  await expect(page.getByRole("button", { name: "Warm filter" })).toHaveAttribute("aria-pressed", "true");
  expect((await readElements(page))[0]?.effects?.[0]?.params.temperature).toBe(Math.round(45 * 0.3));
  await undo(page);
  expect((await readElements(page))[0]?.effects?.[0]?.params.temperature).toBe(45);
});

test("sliders move pixels, one undo per gesture, and reset returns to zero", async ({ page }) => {
  await expect.poll(async () => (await center(page))[0]).toBeGreaterThan(80);
  const base = (await center(page))[0];
  await setSlider(page, "Brightness slider", 50);
  await expect.poll(async () => (await center(page))[0]).toBeGreaterThan(base + 30);
  await setSlider(page, "Saturation slider", -100);
  await setSlider(page, "Vignette slider", 60);
  expect((await readElements(page))[0]?.effects?.[0]?.params).toMatchObject({ brightness: 50, saturation: -100, vignette: 60 });
  await expect(page.getByText("Custom look")).toBeVisible();

  await undo(page);
  expect((await readElements(page))[0]?.effects?.[0]?.params.vignette).toBe(0);
  expect((await readElements(page))[0]?.effects?.[0]?.params.saturation).toBe(-100);

  await page.getByRole("button", { name: "Reset Brightness" }).click();
  await expect.poll(async () => (await readElements(page))[0]?.effects?.[0]?.params.brightness).toBe(0);
  await expect.poll(async () => Math.abs((await center(page))[0] - base)).toBeLessThan(10);
  await shot(page, "adjust-sliders-panel", page.locator(".properties"));
});

test("typing a value and arrow keys work; the panel stays inside the viewport at 1280x720", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.getByRole("textbox", { name: "Contrast", exact: true }).fill("35");
  await page.getByRole("textbox", { name: "Contrast", exact: true }).press("Enter");
  await expect.poll(async () => (await readElements(page))[0]?.effects?.[0]?.params.contrast).toBe(35);
  const slider = page.getByRole("slider", { name: "Exposure slider" });
  await slider.focus();
  await slider.press("ArrowRight");
  await expect.poll(async () => (await readElements(page))[0]?.effects?.[0]?.params.exposure).toBe(1);
  const panel = await page.locator(".properties__content").boundingBox();
  const inner = await page.locator(".properties__content .filter-grid").boundingBox();
  expect(panel && inner && inner.x >= panel.x - 0.5 && inner.x + inner.width <= panel.x + panel.width + 0.5).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await shot(page, "adjust-1280x720");
});
