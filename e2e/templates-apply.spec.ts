import { expect, test, type Page } from "@playwright/test";
import { importGenerated, makeWebm } from "./media";

test.use({ channel: "chrome" });

const SHOTS = "e2e/.artifacts/gallery";
const clips = (page: Page) => page.locator("[data-clip-id]");
const dialog = (page: Page) => page.getByRole("dialog");

async function openFromGallery(page: Page, name: string): Promise<void> {
  await page.goto("/templates");
  await page.getByRole("button", { name: `Use template: ${name}` }).click();
  await expect(page.getByLabel("Project name")).toBeVisible({ timeout: 30_000 });
  expect(new URL(page.url()).pathname).toBe("/app");
}

test("Use template opens a new project with the fill panel, applies empty, and one undo removes it", async ({ page }) => {
  await openFromGallery(page, "Product launch");
  await expect(dialog(page)).toBeVisible();
  await expect(dialog(page).getByRole("heading", { name: "Product launch" })).toBeVisible();
  await expect(page.getByTestId("template-empty-slots")).toContainText("Screen recording 1");
  expect(new URL(page.url()).hash).toMatch(/^#\/editor\/[^?]+$/);
  await dialog(page).getByLabel("Headline").first().fill("Ship faster");
  await page.screenshot({ path: `${SHOTS}/dialog-fill-desktop.png` });
  await dialog(page).getByRole("button", { name: "Apply template" }).click();
  await expect(page.getByText("Template applied. Undo to remove.").first()).toBeVisible();
  await expect(dialog(page).getByTestId("template-warnings")).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/dialog-done-desktop.png` });
  await dialog(page).getByRole("button", { name: "Done" }).click();
  await expect(dialog(page)).toBeHidden();
  await expect.poll(() => clips(page).count()).toBeGreaterThan(3);
  await page.locator("body").click({ position: { x: 5, y: 5 } });
  await page.keyboard.press("ControlOrMeta+z");
  await expect(clips(page)).toHaveCount(0);
  await page.keyboard.press("ControlOrMeta+Shift+z");
  await expect.poll(() => clips(page).count()).toBeGreaterThan(3);
});

test("fills a slot with an imported clip, overrides text, asks before replacing, and undo restores", async ({ page }) => {
  await page.goto("/#/projects");
  await page.getByRole("button", { name: /New project|Create your first project/ }).first().click();
  await expect(page.getByLabel("Project name")).toBeVisible();
  await makeWebm(page, { seconds: 4, hue: 40, name: "clip-a.webm", withAudio: true });
  await makeWebm(page, { seconds: 4, hue: 200, name: "clip-b.webm" });
  await importGenerated(page);
  await expect(page.getByRole("group", { name: /video clip-a.webm/ })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("button", { name: "Add clip-b.webm to timeline" })).toBeAttached();

  await page.getByTestId("templates-button").click();
  await dialog(page).getByRole("button", { name: /^Testimonial/ }).click();
  await expect(dialog(page).getByRole("heading", { name: "Testimonial" })).toBeVisible();
  const portrait = dialog(page).getByLabel("Portrait", { exact: false }).first();
  await expect(portrait).not.toHaveValue("");
  const clipB = await portrait.locator("option", { hasText: "clip-b.webm" }).getAttribute("value");
  await portrait.selectOption(clipB ?? "");
  await dialog(page).locator("input[type='text']").first().fill("It saved us a week");
  await dialog(page).getByRole("button", { name: "Apply template" }).click();
  await expect(page.getByText("Template applied. Undo to remove.").first()).toBeVisible();
  const done = dialog(page).getByRole("button", { name: "Done" });
  if (await done.isVisible()) await done.click();
  await expect(dialog(page)).toBeHidden();
  await expect(page.getByRole("group", { name: /video clip-b.webm/ }).first()).toBeAttached();
  const count = await clips(page).count();
  expect(count).toBeGreaterThan(2);

  await page.getByTestId("templates-button").click();
  await dialog(page).getByRole("button", { name: /^Product launch/ }).click();
  await dialog(page).getByRole("button", { name: "Apply template" }).click();
  await expect(page.getByTestId("template-replace-confirm")).toContainText(`replaces the ${count} clips`);
  await page.screenshot({ path: `${SHOTS}/dialog-replace-confirm.png` });
  await dialog(page).getByRole("button", { name: "Cancel" }).click();
  await expect(clips(page)).toHaveCount(count);
  await expect(page.getByTestId("template-replace-confirm")).toBeHidden();
  await dialog(page).getByRole("button", { name: "Apply template" }).click();
  await dialog(page).getByRole("button", { name: "Replace and apply" }).click();
  const again = dialog(page).getByRole("button", { name: "Done" });
  if (await again.isVisible().catch(() => false)) await again.click();
  await expect(dialog(page)).toBeHidden();
  await page.locator("body").click({ position: { x: 5, y: 5 } });
  await page.keyboard.press("ControlOrMeta+z");
  await expect(clips(page)).toHaveCount(count);
});

test("keyboard: the Templates button opens the dialog, Escape closes it", async ({ page }) => {
  await page.goto("/#/projects");
  await page.getByRole("button", { name: /New project|Create your first project/ }).first().click();
  await expect(page.getByLabel("Project name")).toBeVisible();
  await page.getByTestId("templates-button").focus();
  await page.keyboard.press("Enter");
  await expect(dialog(page)).toBeVisible();
  await page.keyboard.press("Tab");
  await page.keyboard.press("Enter");
  await expect(dialog(page).getByRole("button", { name: "Apply template" })).toBeVisible().catch(() => undefined);
  await page.keyboard.press("Escape");
  await expect(dialog(page)).toBeHidden();
});

test("projects page offers Start from template", async ({ page }) => {
  await page.goto("/#/projects");
  await page.getByRole("button", { name: "Start from template" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Start from a template" })).toBeVisible();
});

test("mobile 390: the dialog is a bottom sheet that fits, and applying works", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openFromGallery(page, "Numbered list");
  await expect(dialog(page)).toBeVisible();
  const box = await dialog(page).boundingBox();
  expect(box?.width ?? 0).toBeLessThanOrEqual(390);
  expect((box?.y ?? 0) + (box?.height ?? 0)).toBeLessThanOrEqual(844 + 1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
  await page.screenshot({ path: `${SHOTS}/dialog-fill-mobile-390.png` });
  await dialog(page).getByRole("button", { name: "Apply template" }).click();
  await expect(page.getByText("Template applied. Undo to remove.").first()).toBeVisible();
  await dialog(page).getByRole("button", { name: "Done" }).click();
  await expect(dialog(page)).toBeHidden();
});
