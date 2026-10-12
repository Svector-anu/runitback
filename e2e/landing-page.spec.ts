import { expect, test, type Page } from "@playwright/test";
import { makeWebm } from "./media";

const SHOTS = "e2e/.artifacts/landing/out";

async function openLanding(page: Page): Promise<void> {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await page.evaluate(async () => { await document.fonts.ready; });
}

test("nav anchors scroll to their section without leaving the landing page", async ({ page }) => {
  await openLanding(page);
  const nav = page.getByRole("navigation", { name: "Page sections" });
  for (const [label, id] of [["Features", "features"], ["How it works", "how-it-works"], ["FAQ", "faq"]] as const) {
    await nav.getByRole("link", { name: label }).click();
    await expect.poll(async () => page.evaluate((target) => Math.round(document.getElementById(target)?.getBoundingClientRect().top ?? 9999), id), { timeout: 5000 }).toBeLessThan(140);
    await expect(page.locator(`#${id}`)).toBeFocused();
    expect(new URL(page.url()).hash).toBe("");
    await expect(page.getByRole("heading", { level: 1 })).toBeAttached();
  }
});

test("the nav stays pinned and gains a blurred background after scrolling", async ({ page }) => {
  await openLanding(page);
  const header = page.locator("header.lp-nav");
  await expect(header).toHaveAttribute("data-scrolled", "false");
  await page.mouse.wheel(0, 1200);
  await expect(header).toHaveAttribute("data-scrolled", "true");
  const box = await header.boundingBox();
  expect(box?.y).toBe(0);
  expect(await header.evaluate((el) => getComputedStyle(el).backdropFilter)).toContain("blur");
});

test("the hero call to action opens the editor shell", async ({ page }) => {
  await openLanding(page);
  await page.getByRole("button", { name: "Start editing" }).click();
  await expect(page).toHaveURL(/\/app$/);
  await expect(page.getByRole("button", { name: /New project|Create your first project/ }).first()).toBeVisible();
});

test("the nav call to action is a link to /app", async ({ page }) => {
  await openLanding(page);
  await expect(page.getByRole("banner").getByRole("link", { name: "Start editing" })).toHaveAttribute("href", "/app");
});

test("FAQ accordion works from the keyboard", async ({ page }) => {
  await openLanding(page);
  const questions = page.locator("#faq h3 button");
  await expect(questions).toHaveCount(6);
  await expect(questions.nth(0)).toHaveAttribute("aria-expanded", "true");
  await questions.nth(0).focus();
  await page.keyboard.press("Enter");
  await expect(questions.nth(0)).toHaveAttribute("aria-expanded", "false");
  await page.keyboard.press("ArrowDown");
  await expect(questions.nth(1)).toBeFocused();
  await page.keyboard.press("Space");
  await expect(questions.nth(1)).toHaveAttribute("aria-expanded", "true");
  const answer = page.locator("#faq-a-1");
  await expect(answer).toBeVisible();
  await expect(answer).toContainText("Anthropic");
  await page.keyboard.press("End");
  await expect(questions.nth(5)).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.locator("#faq-a-5")).toContainText(/source available soon/i);
  await expect(page.locator("#faq-a-1")).toBeHidden();
  await page.keyboard.press("Home");
  await expect(questions.nth(0)).toBeFocused();
});

test("theme toggle switches both themes and persists across a reload", async ({ page }) => {
  await openLanding(page);
  const background = (): Promise<string> => page.evaluate(() => getComputedStyle(document.querySelector(".zn")!).backgroundColor);
  const before = await background();
  await page.getByRole("button", { name: "Switch to dark theme" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  const dark = await background();
  expect(dark).not.toBe(before);
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.getByRole("button", { name: "Switch to light theme" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  expect(await background()).toBe(before);
});

test("the demo video slot stays hidden while demo.mp4 is missing", async ({ page }) => {
  await page.route("**/landing/demo.mp4", (route) => route.fulfill({ status: 404, body: "not found" }));
  await openLanding(page);
  const slot = page.locator(".lp-demo");
  await expect(slot).toHaveAttribute("data-ready", "false");
  await expect(page.locator(".lp-demo video")).toBeHidden();
  await expect(page.getByRole("heading", { name: "A real editor, with an agent beside it." })).toBeVisible();
});

test("the demo video slot appears once a playable demo.mp4 exists", async ({ page }) => {
  await page.goto("/");
  await makeWebm(page, { seconds: 1, hue: 40, name: "demo.webm" });
  const bytes = await page.evaluate(async () => {
    const file = (window as unknown as { __files: File[] }).__files[0]!;
    return Array.from(new Uint8Array(await file.arrayBuffer()));
  });
  await page.route("**/landing/demo.mp4", (route) => route.fulfill({ status: 200, contentType: "video/webm", body: Buffer.from(bytes) }));
  await page.reload();
  await expect(page.locator(".lp-demo")).toHaveAttribute("data-ready", "true", { timeout: 15_000 });
  await expect(page.locator(".lp-demo video")).toBeVisible();
});

test("the page has one h1, no skipped heading levels, labelled images and a labelled landmark structure", async ({ page }) => {
  await openLanding(page);
  const levels = await page.evaluate(() => Array.from(document.querySelectorAll("h1,h2,h3,h4")).map((h) => Number(h.tagName[1])));
  expect(levels.filter((l) => l === 1)).toHaveLength(1);
  for (let i = 1; i < levels.length; i++) expect(levels[i]! - levels[i - 1]!).toBeLessThanOrEqual(1);
  expect(await page.locator("img:not([alt]), img[alt='']").count()).toBe(0);
  await expect(page.getByRole("main")).toBeVisible();
  await expect(page.getByRole("contentinfo")).toBeVisible();
  await expect(page.getByRole("region", { name: "How it works" })).toBeVisible();
});

test("reduced motion shows every section immediately without reveal transitions", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await openLanding(page);
  await expect(page.locator(".zn")).not.toHaveAttribute("data-reveal", "armed");
  const hidden = await page.evaluate(() => Array.from(document.querySelectorAll(".zn-reveal")).filter((el) => getComputedStyle(el).opacity !== "1").length);
  expect(hidden).toBe(0);
});

test("scroll reveals fade sections in when they enter the viewport", async ({ page }) => {
  await openLanding(page);
  await expect(page.locator(".zn")).toHaveAttribute("data-reveal", "armed");
  const faq = page.locator("#faq .lp-faq__item").nth(3);
  await expect(faq).not.toHaveClass(/is-in/);
  await faq.scrollIntoViewIfNeeded();
  await expect(faq).toHaveClass(/is-in/);
});

test("mobile 390: no horizontal scroll, the menu opens and navigates, the page fits", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openLanding(page);
  const overflow = (): Promise<{ scroll: number; client: number }> => page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
  const initial = await overflow();
  expect(initial.scroll).toBeLessThanOrEqual(initial.client);
  await expect(page.getByRole("navigation", { name: "Page sections" })).toBeHidden();
  const menu = page.getByRole("button", { name: "Menu" });
  await menu.click();
  await expect(menu).toHaveAttribute("aria-expanded", "true");
  await page.getByRole("navigation", { name: "Menu" }).getByRole("link", { name: "FAQ" }).click();
  await expect(page.getByRole("navigation", { name: "Menu" })).toBeHidden();
  await expect.poll(async () => page.evaluate(() => Math.round(document.getElementById("faq")?.getBoundingClientRect().top ?? 9999))).toBeLessThan(140);
  await page.evaluate(async () => { for (let y = 0; y < document.documentElement.scrollHeight; y += 600) { window.scrollTo(0, y); await new Promise((r) => setTimeout(r, 40)); } });
  const after = await overflow();
  expect(after.scroll).toBeLessThanOrEqual(after.client);
});

test("works at 360px wide without horizontal scroll", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 740 });
  await openLanding(page);
  const { scroll, client } = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
  expect(scroll).toBeLessThanOrEqual(client);
  await page.screenshot({ path: `${SHOTS}/e2e-360.png`, fullPage: true });
});

test("the editor chunk is not pulled in by the landing page", async ({ page }) => {
  const requested: string[] = [];
  page.on("request", (request) => requested.push(request.url()));
  await openLanding(page);
  expect(requested.some((url) => /EditorPage/.test(url))).toBe(false);
});
