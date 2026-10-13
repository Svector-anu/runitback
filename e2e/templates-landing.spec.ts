import { expect, test } from "@playwright/test";

test("the landing has a Templates section with four featured cards, a nav link and a link to /templates", async ({ page }) => {
  await page.goto("/");
  const nav = page.getByRole("navigation", { name: "Page sections" });
  await nav.getByRole("link", { name: "Templates" }).click();
  await expect.poll(() => page.evaluate(() => Math.round(document.getElementById("templates")?.getBoundingClientRect().top ?? 9999))).toBeLessThan(140);
  expect(new URL(page.url()).hash).toBe("");
  const section = page.locator("#templates");
  await expect(section.locator("[data-template-id]")).toHaveCount(4);
  await expect(section.locator("img").first()).toBeVisible();
  await section.scrollIntoViewIfNeeded();
  await page.waitForTimeout(900);
  await page.screenshot({ path: "e2e/.artifacts/gallery/landing-templates-section.png" });
  await section.getByRole("link", { name: "Browse all templates" }).click();
  await expect(page).toHaveURL(/\/templates$/);
  await expect(page.getByRole("heading", { level: 1, name: "Start from a template" })).toBeVisible();
});

test("the hero links to /templates and the FAQ answers the own-template question honestly", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".lp-hero").getByRole("link", { name: "Start from a template" })).toHaveAttribute("href", "/templates");
  const question = page.getByRole("button", { name: /Are templates free/ });
  await question.click();
  const panel = page.locator(`#${await question.getAttribute("aria-controls")}`);
  await expect(panel).toContainText("coming soon");
  await expect(panel.getByRole("link", { name: "Read docs/TEMPLATES.md" })).toHaveAttribute("href", /docs\/TEMPLATES\.md$/);
});

test("landing mobile 360: templates section does not overflow", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 800 });
  await page.goto("/");
  await page.locator("#templates").scrollIntoViewIfNeeded();
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
  await page.waitForTimeout(900);
  await page.screenshot({ path: "e2e/.artifacts/gallery/landing-templates-mobile-360.png" });
});
