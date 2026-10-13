import { expect, test, type Page } from "@playwright/test";
import {
  countPreviewPixels, openEditorWithClips, openPropertyTab, previewPixels, readElements, seekSeconds, selectClip, setSlider, shot, undo, type Rgb,
} from "./ctl-support";

test.use({ channel: "chrome" });

const near = (actual: Rgb, expected: Rgb, tolerance = 40): boolean => actual.every((v, i) => Math.abs(v - (expected[i] as number)) <= tolerance);
const RED_PIXELS = "r > 200 && g < 70 && b < 70";
const GREEN_PIXELS = "g > 200 && r < 70 && b < 70";
const WHITE_PIXELS = "r > 200 && g > 200 && b > 200";

test("crop sliders cut the preview, accept keyframes, and undo restores the picture", async ({ page }) => {
  await openEditorWithClips(page, [{ name: "bands.webm", color: "#000000", seconds: 4, pattern: "bands" }]);
  await selectClip(page, 0);
  const probes: Array<[number, number]> = [[0.125, 0.5], [0.375, 0.5], [0.625, 0.5], [0.875, 0.5], [0.625, 0.125], [0.625, 0.875]];
  await expect.poll(async () => near((await previewPixels(page, [probes[0]!]))[0] as Rgb, [255, 0, 0])).toBe(true);
  expect(await page.getByRole("slider", { name: "Crop left slider" }).count()).toBe(1);

  await setSlider(page, "Crop left slider", 0.5);
  await expect.poll(async () => near((await previewPixels(page, [probes[0]!]))[0] as Rgb, [0, 0, 0], 20)).toBe(true);
  const after = await previewPixels(page, probes);
  expect(near(after[1] as Rgb, [0, 0, 0], 20)).toBe(true);
  expect((after[2] as Rgb)[2]).toBeGreaterThan(200);
  expect(near(after[3] as Rgb, [128, 128, 128], 20)).toBe(true);
  await shot(page, "crop-left-half");
  await shot(page, "crop-panel", page.locator(".properties"));

  await setSlider(page, "Crop top slider", 0.4);
  await expect.poll(async () => near((await previewPixels(page, [probes[4]!]))[0] as Rgb, [0, 0, 0], 25)).toBe(true);
  expect(near((await previewPixels(page, [probes[5]!]))[0] as Rgb, [0, 0, 255], 40)).toBe(true);
  expect((await readElements(page))[0]?.params).toMatchObject({ "crop.left": 0.5, "crop.top": 0.4 });

  await undo(page);
  await expect.poll(async () => (await readElements(page))[0]?.params["crop.top"]).toBe(0);
  await undo(page);
  await expect.poll(async () => near((await previewPixels(page, [probes[0]!]))[0] as Rgb, [255, 0, 0])).toBe(true);
});

test("crop edges clamp at 95 percent and keyframe diamonds animate the value", async ({ page }) => {
  await openEditorWithClips(page, [{ name: "bands.webm", color: "#000000", seconds: 4, pattern: "bands" }]);
  await selectClip(page, 0);
  const field = page.getByRole("textbox", { name: "Crop right", exact: true });
  await field.fill("200");
  await field.press("Enter");
  await expect.poll(async () => (await readElements(page))[0]?.params["crop.right"]).toBe(0.95);
  await page.getByRole("button", { name: "Reset Crop right" }).click();
  await expect.poll(async () => (await readElements(page))[0]?.params["crop.right"]).toBe(0);

  const diamond = page.getByRole("button", { name: "Add Crop left keyframe" });
  await expect(diamond).toHaveAttribute("aria-pressed", "false");
  await diamond.click();
  await expect(page.getByRole("button", { name: "Remove Crop left keyframe" })).toHaveAttribute("aria-pressed", "true");
  expect((await readElements(page))[0]?.animations).toHaveProperty(["crop.left"]);

  await seekSeconds(page, 2);
  await setSlider(page, "Crop left slider", 0.6);
  await expect.poll(async () => {
    const keys = ((await readElements(page))[0]?.animations?.["crop.left"] as { channel?: { keys: unknown[] } } | undefined)?.channel?.keys;
    return keys?.length;
  }).toBe(2);
  await expect.poll(async () => near((await previewPixels(page, [[0.1, 0.5]]))[0] as Rgb, [0, 0, 0], 25)).toBe(true);
  await seekSeconds(page, 0);
  await expect.poll(async () => near((await previewPixels(page, [[0.1, 0.5]]))[0] as Rgb, [255, 0, 0], 40)).toBe(true);
});

async function addStyledText(page: Page): Promise<void> {
  await openEditorWithClips(page, [{ name: "black.webm", color: "#000000", seconds: 6 }]);
  await page.getByRole("tablist", { name: "Asset tabs" }).getByRole("tab", { name: "Text", exact: true }).click();
  await page.getByRole("button", { name: "Add Default text to timeline" }).click({ force: true });
  await expect(page.locator(".clip--text")).toHaveCount(1);
  await page.locator(".clip--text").click();
  await expect(page.locator(".clip--text")).toHaveAttribute("data-selected", "true");
  await openPropertyTab(page, "Text");
  const size = page.getByRole("textbox", { name: "Font size", exact: true });
  await size.fill("120");
  await size.press("Enter");
  await expect.poll(() => countPreviewPixels(page, WHITE_PIXELS)).toBeGreaterThan(500);
}

test("text stroke is drawn in the chosen colour and width; undo removes it", async ({ page }) => {
  await addStyledText(page);
  await openPropertyTab(page, "Style");
  expect(await countPreviewPixels(page, RED_PIXELS)).toBe(0);
  const color = page.getByRole("textbox", { name: "Stroke color", exact: true });
  await color.fill("#ff0000");
  await color.press("Enter");
  await setSlider(page, "Stroke width slider", 8);
  await expect.poll(() => countPreviewPixels(page, RED_PIXELS)).toBeGreaterThan(300);
  await shot(page, "text-stroke");
  await shot(page, "text-style-panel", page.locator(".properties"));
  await undo(page);
  await expect.poll(() => countPreviewPixels(page, RED_PIXELS)).toBe(0);
});

test("text shadow: enabling reveals its controls and draws the shadow colour", async ({ page }) => {
  await addStyledText(page);
  await openPropertyTab(page, "Style");
  await expect(page.getByRole("slider", { name: "Shadow blur slider" })).toHaveCount(0);
  await page.getByRole("switch", { name: "Shadow" }).click();
  await expect(page.getByRole("slider", { name: "Shadow blur slider" })).toBeVisible();
  const color = page.getByRole("textbox", { name: "Shadow color", exact: true });
  await color.fill("#00ff00");
  await color.press("Enter");
  await setSlider(page, "Shadow blur slider", 0);
  await setSlider(page, "Shadow offset X slider", 20);
  await setSlider(page, "Shadow offset Y slider", 20);
  await expect.poll(() => countPreviewPixels(page, GREEN_PIXELS)).toBeGreaterThan(300);
  await shot(page, "text-shadow");
  expect((await readElements(page)).find((e) => e.type === "text")?.params).toMatchObject({ "shadow.enabled": true, "shadow.offsetX": 20, "shadow.offsetY": 20, "shadow.blur": 0 });
});

test("text in/out animation pickers write real animations and change the picture over time", async ({ page }) => {
  await addStyledText(page);
  await openPropertyTab(page, "Style");
  const fadeIn = page.getByRole("group", { name: "In animation" }).getByRole("button", { name: "Fade" });
  await fadeIn.click();
  await expect(fadeIn).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("group", { name: "Out animation" }).getByRole("button", { name: "Pop" }).click();
  const text = async () => (await readElements(page)).find((e) => e.type === "text");
  expect((await text())?.textAnimation).toMatchObject({ in: { preset: "fade" }, out: { preset: "pop" } });
  await expect(page.getByRole("slider", { name: "In animation length slider" })).toBeVisible();

  await seekSeconds(page, 0);
  await expect.poll(() => countPreviewPixels(page, WHITE_PIXELS)).toBeLessThan(50);
  await seekSeconds(page, 2);
  await expect.poll(() => countPreviewPixels(page, WHITE_PIXELS)).toBeGreaterThan(500);
  await shot(page, "text-animation-panel", page.locator(".properties"));

  await setSlider(page, "In animation length slider", 120_000);
  await expect.poll(async () => (await text())?.textAnimation?.in?.duration).toBe(120_000);
  await page.getByRole("group", { name: "In animation" }).getByRole("button", { name: "None" }).click();
  await expect.poll(async () => (await text())?.textAnimation).not.toHaveProperty("in");
  await undo(page);
  await expect.poll(async () => (await text())?.textAnimation?.in?.preset).toBe("fade");
});
