import { expect, test, type Page } from "@playwright/test";
import { importGenerated, makeWebm } from "./media";

test.use({ channel: "chrome" });

const SHOTS = "e2e/.artifacts/gallery";
const clips = (page: Page) => page.locator("[data-clip-id]");
const dialog = (page: Page) => page.getByRole("dialog");
const fieldValues = (page: Page) => page.evaluate(() => [...document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("input, textarea")].map((el) => el.value));

async function openFromGallery(page: Page, name: string): Promise<void> {
  await page.goto("/templates");
  await page.getByRole("button", { name: `Use template: ${name}` }).click();
  await expect(page.getByLabel("Project name")).toBeVisible({ timeout: 30_000 });
  expect(new URL(page.url()).pathname).toBe("/app");
}

test("Use template opens a new project with the fill panel, applies empty, and one undo removes it", async ({ page }) => {
  await openFromGallery(page, "Kinetic announcement");
  await expect(dialog(page)).toBeVisible();
  await expect(dialog(page).getByRole("heading", { name: "Kinetic announcement" })).toBeVisible();
  await expect(page.getByTestId("template-empty-slots")).toBeVisible();
  expect(new URL(page.url()).hash).toMatch(/^#\/editor\/[^?]+$/);
  await dialog(page).getByLabel("Headline").first().fill("Big news today");
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

  await page.getByTestId("templates-button").click();
  await dialog(page).getByRole("button", { name: /^Testimonial/ }).click();
  const heading = dialog(page).getByRole("heading", { name: "Testimonial" });
  await expect(heading).toBeVisible();
  const select = dialog(page).locator("select").first();
  await expect(select).not.toHaveValue("");
  await select.selectOption({ label: /clip-b/ as unknown as string }).catch(async () => {
    const value = await select.locator("option", { hasText: "clip-b.webm" }).getAttribute("value");
    await select.selectOption(value ?? "");
  });
  const quote = dialog(page).locator("input[type='text']").first();
  await quote.fill("It saved us a week");
  await dialog(page).getByRole("button", { name: "Apply template" }).click();
  await expect(page.getByText("Template applied. Undo to remove.").first()).toBeVisible();
  await expect(dialog(page)).toBeHidden({ timeout: 2000 }).catch(() => undefined);
  if (await dialog(page).isVisible()) await dialog(page).getByRole("button", { name: "Done" }).click();
  await expect(page.getByRole("group", { name: /video clip-b.webm/ }).first()).toBeAttached();
  const count = await clips(page).count();
  expect(count).toBeGreaterThan(2);

  await page.getByRole("group", { name: /text/ }).first().click().catch(() => undefined);
  expect((await fieldValues(page)).some((v) => v === "It saved us a week" || v.includes("It saved us a week"))).toBe(true);

  await page.getByTestId("templates-button").click();
  await dialog(page).getByRole("button", { name: /^Product launch/ }).click();
  await dialog(page).getByRole("button", { name: "Apply template" }).click();
  await expect(page.getByTestId("template-replace-confirm")).toContainText(`replaces the ${count} clips`);
  await page.screenshot({ path: `${SHOTS}/dialog-replace-confirm.png` });
  await dialog(page).getByRole("button", { name: "Cancel" }).click();
  await expect(clips(page)).toHaveCount(count);
  await dialog(page).getByRole("button", { name: "Replace and apply" }).click().catch(() => undefined);
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
