import { expect, test, type Page } from "@playwright/test";

// Real Chrome: the preview videos are H.264 MP4, which bundled Chromium cannot play.
test.use({ channel: "chrome" });

const SHOTS = "e2e/.artifacts/gallery";
const cards = (page: Page) => page.locator("[data-template-id]");
const playingCount = (page: Page) =>
  page.evaluate(() => [...document.querySelectorAll<HTMLVideoElement>("video[data-testid='template-preview']")].filter((v) => !v.paused && !v.ended).length);
const videoCount = (page: Page) => page.locator("video[data-testid='template-preview']").count();
const overflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

test("/templates renders the eight original templates with badges, chips and the Use button", async ({ page }) => {
  await page.goto("/templates");
  await expect(page.getByRole("heading", { level: 1, name: "Start from a template" })).toBeVisible();
  await expect(page.getByTestId("template-grid").locator("[data-template-id]")).toHaveCount(8);
  const first = cards(page).first();
  await expect(first.getByRole("heading", { level: 3 })).toHaveText("Product launch");
  await expect(first.getByRole("button", { name: /Use template/ })).toBeVisible();
  await expect(first).toContainText("0:25");
  await expect(first).toContainText("16:9");
  await expect(page.getByRole("link", { name: "Home" }).first()).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/gallery-desktop-light.png`, fullPage: true });
});

test("/#/templates reaches the same page", async ({ page }) => {
  await page.goto("/#/templates");
  await expect(cards(page)).toHaveCount(8);
});

test("category chips and search filter the grid", async ({ page }) => {
  await page.goto("/templates");
  const group = page.getByRole("group", { name: "Category" });
  await group.getByRole("button", { name: "List" }).click();
  await expect(cards(page)).toHaveCount(1);
  await expect(cards(page).first()).toContainText("Numbered list");
  await expect(group.getByRole("button", { name: "List" })).toHaveAttribute("aria-pressed", "true");
  await group.getByRole("button", { name: "All" }).click();
  await expect(cards(page)).toHaveCount(8);
  await page.getByRole("searchbox", { name: "Search templates" }).fill("zzzz");
  await expect(page.getByText("No template matches")).toBeVisible();
  await page.getByRole("button", { name: "Clear filters" }).click();
  await expect(cards(page)).toHaveCount(8);
});

test("at most four previews play at once and the pause toggle persists", async ({ page }) => {
  await page.setViewportSize({ width: 1800, height: 2400 });
  await page.goto("/templates");
  await expect.poll(() => playingCount(page), { timeout: 15_000 }).toBeGreaterThan(0);
  expect(await videoCount(page)).toBeLessThanOrEqual(4);
  expect(await playingCount(page)).toBeLessThanOrEqual(4);
  const toggle = page.getByRole("button", { name: "Pause previews" });
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  await expect.poll(() => videoCount(page)).toBe(0);
  await page.reload();
  await expect(page.getByRole("button", { name: "Pause previews" })).toHaveAttribute("aria-pressed", "true");
  expect(await videoCount(page)).toBe(0);
  await expect(cards(page).first().locator("img")).toBeVisible();
});

test.describe("reduced motion", () => {
  test.use({ reducedMotion: "reduce" });
  test("shows posters only and disables the toggle", async ({ page }) => {
    await page.goto("/templates");
    await expect(cards(page)).toHaveCount(8);
    await page.waitForTimeout(800);
    expect(await videoCount(page)).toBe(0);
    await expect(page.getByRole("button", { name: "Pause previews" })).toBeDisabled();
    await expect(cards(page).first().locator("img")).toBeVisible();
  });
});

test("keyboard: tab reaches filters, cards and Use template; Enter on a chip filters", async ({ page }) => {
  await page.goto("/templates");
  await page.getByRole("group", { name: "Category" }).getByRole("button", { name: "Launch", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(cards(page)).toHaveCount(1);
  const use = page.getByRole("button", { name: /Use template: Product launch/ });
  for (let i = 0; i < 20 && !(await use.evaluate((el) => el === document.activeElement)); i++) await page.keyboard.press("Tab");
  await expect(use).toBeFocused();
});

test("the Inspiration list is collapsed, text-only, and links out safely", async ({ page }) => {
  await page.goto("/templates");
  const inspo = page.getByTestId("inspiration");
  await expect(inspo.locator("a").first()).toBeHidden();
  await inspo.getByText("Inspiration", { exact: true }).click();
  await expect(inspo).toContainText("Our templates are original; these are posts that inspired them.");
  const links = inspo.locator("a");
  expect(await links.count()).toBeGreaterThanOrEqual(3);
  for (const link of await links.all()) {
    await expect(link).toHaveAttribute("target", "_blank");
    await expect(link).toHaveAttribute("rel", /noopener/);
  }
  await expect(inspo.locator("img, video, iframe")).toHaveCount(0);
  await page.screenshot({ path: `${SHOTS}/gallery-inspiration-open.png` });
});

test("dark theme screenshot", async ({ page }) => {
  await page.goto("/templates");
  await page.getByRole("button", { name: "Switch to dark theme" }).first().click();
  await expect(cards(page)).toHaveCount(8);
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${SHOTS}/gallery-desktop-dark.png`, fullPage: false });
});

for (const width of [360, 390]) {
  test(`mobile ${width}: no horizontal scroll, one column, reachable controls`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    await page.goto("/templates");
    await expect(cards(page)).toHaveCount(8);
    expect(await overflow(page)).toBeLessThanOrEqual(0);
    const boxes = await cards(page).evaluateAll((els) => els.map((el) => Math.round(el.getBoundingClientRect().left)));
    expect(new Set(boxes).size).toBe(1);
    await page.getByTestId("inspiration").getByText("Inspiration", { exact: true }).click();
    expect(await overflow(page)).toBeLessThanOrEqual(0);
    const button = cards(page).first().getByRole("button", { name: /Use template/ });
    expect((await button.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(40);
    await page.screenshot({ path: `${SHOTS}/gallery-mobile-${width}.png`, fullPage: true });
  });
}
