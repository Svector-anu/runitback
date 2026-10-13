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
  for (const [label, id] of [["Templates", "templates"], ["Features", "features"], ["How it works", "how-it-works"], ["Compare", "compare"], ["Open source", "open-source"], ["FAQ", "faq"]] as const) {
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
  await expect(questions).toHaveCount(12);
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
  await expect(answer).toContainText("7 transitions");
  await page.keyboard.press("End");
  await expect(questions.nth(11)).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.locator("#faq-a-11")).toContainText(/CONTRIBUTING/);
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
  const faq = page.locator("#faq .lp-faq__aside");
  await expect(faq).not.toHaveClass(/is-in/);
  await faq.scrollIntoViewIfNeeded();
  await expect(faq).toHaveClass(/is-in/);
});

test("every FAQ item stays visible and opens after a jump scroll to the section", async ({ page }) => {
  await openLanding(page);
  await page.locator("#faq").scrollIntoViewIfNeeded();
  const questions = page.locator("#faq h3 button");
  for (const index of [6, 0, 9]) {
    await questions.nth(index).click();
    await expect(questions.nth(index)).toHaveAttribute("aria-expanded", "true");
    await expect(page.locator(`#faq-a-${index}`)).toBeVisible();
    await expect(page.locator("#faq .lp-faq__item").nth(index)).toHaveCSS("opacity", "1");
  }
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

const REPO = "https://github.com/Svector-anu/runitback";

test("GitHub star links are plain external links to the repository in the nav, hero, open source section, final CTA and footer", async ({ page }) => {
  await openLanding(page);
  const links = page.locator(`a[href="${REPO}"]`);
  expect(await links.count()).toBeGreaterThanOrEqual(5);
  for (const link of await links.all()) {
    await expect(link).toHaveAttribute("target", "_blank");
    await expect(link).toHaveAttribute("rel", /noopener/);
  }
  await expect(page.getByRole("banner").getByRole("link", { name: "Star on GitHub" })).toHaveAttribute("href", REPO);
  await expect(page.locator(".lp-hero").getByRole("link", { name: "Star on GitHub" })).toBeVisible();
  await expect(page.getByText("Open source · MIT").first()).toBeVisible();
  await expect(page.getByRole("heading", { level: 1 })).toContainText("The open-source CapCut alternative");
});

test("open source section shows the MIT badge and the star link, without OpenCut credit text", async ({ page }) => {
  await openLanding(page);
  const section = page.locator("#open-source");
  await expect(section.getByRole("heading", { name: "Built in the open." })).toBeVisible();
  await expect(section.getByRole("link", { name: "MIT licensed" })).toHaveAttribute("href", `${REPO}/blob/main/LICENSE`);
  await expect(section.getByRole("link", { name: "Star on GitHub" })).toBeVisible();
  await expect(page.locator("main")).not.toContainText("OpenCut");
});

test("the comparison table is honest about where CapCut is ahead and carries the trademark note", async ({ page }) => {
  await openLanding(page);
  const table = page.locator("#compare table");
  await expect(table.locator("tbody tr")).toHaveCount(7);
  await expect(table.locator("tr", { hasText: "Mobile app" })).toContainText("Ahead");
  await expect(table.locator("tr", { hasText: "Templates, stickers and effects" })).toContainText("8 original templates");
  await expect(page.getByRole("contentinfo")).toContainText("CapCut is a trademark of its respective owner. RunItBack is not affiliated with or endorsed by it.");
});

for (const width of [360, 390]) {
  test(`mobile ${width}: new blocks do not overflow and tap targets are at least 44px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    await openLanding(page);
    await page.evaluate(async () => { for (let y = 0; y < document.documentElement.scrollHeight; y += 500) { window.scrollTo(0, y); await new Promise((r) => setTimeout(r, 30)); } });
    const { scroll, client } = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
    expect(scroll).toBeLessThanOrEqual(client);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.getByRole("button", { name: "Menu" }).click();
    const targets = [
      page.getByRole("navigation", { name: "Menu" }).getByRole("link", { name: "Star on GitHub" }),
      page.locator(".lp-hero").getByRole("link", { name: "Star on GitHub" }),
      page.locator("#open-source").getByRole("link", { name: "Star on GitHub" }),
    ];
    for (const target of targets) {
      await target.scrollIntoViewIfNeeded();
      const box = await target.boundingBox();
      expect(box?.height ?? 0).toBeGreaterThanOrEqual(43.5);
    }
    await page.getByRole("button", { name: "Close menu" }).click();
  });
}

test("screenshots of the new positioning (opt-in)", async ({ page }) => {
  test.skip(!process.env.LANDING_MSG_SHOTS, "set LANDING_MSG_SHOTS=1");
  for (const [name, size] of [["desktop", { width: 1440, height: 900 }], ["mobile", { width: 390, height: 844 }]] as const) {
    for (const theme of ["light", "dark"] as const) {
      await page.setViewportSize(size);
      await page.goto("/");
      await page.evaluate((t) => { localStorage.setItem("theme", t); }, theme);
      await page.emulateMedia({ colorScheme: theme });
      await openLanding(page);
      await page.evaluate(async (t) => {
        document.documentElement.dataset.theme = t;
        for (let y = 0; y < document.documentElement.scrollHeight; y += 500) { window.scrollTo(0, y); await new Promise((r) => setTimeout(r, 40)); }
        window.scrollTo(0, 0);
      }, theme);
      await page.screenshot({ path: `e2e/.artifacts/landing/msg/${name}-${theme}.png`, fullPage: true });
    }
  }
});
