import { expect, test, type Page } from "@playwright/test";
import { importGenerated, makeWebm } from "./media";

const clips = (page: Page) => page.locator("[data-clip-id]");

async function pixel(page: Page, x: number, y: number): Promise<number[]> {
  return page.evaluate(([px, py]) => {
    const c = document.querySelector<HTMLCanvasElement>(".preview__scene canvas");
    const ctx = c?.getContext("2d") as CanvasRenderingContext2D;
    return Array.from(ctx.getImageData(px as number, py as number, 1, 1).data.slice(0, 3));
  }, [x, y]);
}

async function countColor(page: Page, test: { r: [number, number]; g: [number, number]; b: [number, number] }): Promise<number> {
  return page.evaluate((t) => {
    const c = document.querySelector<HTMLCanvasElement>(".preview__scene canvas");
    const ctx = c?.getContext("2d") as CanvasRenderingContext2D;
    const d = ctx.getImageData(0, 0, c!.width, c!.height).data;
    let n = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i]! >= t.r[0] && d[i]! <= t.r[1] && d[i + 1]! >= t.g[0] && d[i + 1]! <= t.g[1] && d[i + 2]! >= t.b[0] && d[i + 2]! <= t.b[1]) n++;
    }
    return n;
  }, test);
}

async function projectWithClip(page: Page): Promise<void> {
  await page.goto("/#/projects");
  await page.getByRole("button", { name: /Create your first project|New project/ }).first().click();
  await expect(page.getByLabel("Project name")).toBeVisible();
  await makeWebm(page, { seconds: 4, hue: 10, name: "clip-a.webm" });
  await importGenerated(page);
  await page.getByRole("button", { name: "Add clip-a.webm to timeline" }).click({ force: true });
  await expect(clips(page)).toHaveCount(1);
}

test("mask, opacity and blend are rendered into the preview", async ({ page }) => {
  await projectWithClip(page);
  await clips(page).first().click();
  await expect.poll(() => pixel(page, 5, 5)).not.toEqual([0, 0, 0]);

  // Ellipse mask hides the corners but not the centre.
  await page.getByRole("tab", { name: "Masks" }).click();
  await page.getByRole("button", { name: "Add mask" }).click();
  await page.getByRole("menuitem", { name: "Ellipse" }).click();
  await expect.poll(() => pixel(page, 5, 5)).toEqual([0, 0, 0]);
  expect(await pixel(page, 160, 90)).not.toEqual([0, 0, 0]);

  // Inverting the mask swaps what is visible.
  await page.getByRole("button", { name: "Invert mask", exact: true }).click();
  await expect.poll(() => pixel(page, 5, 5)).not.toEqual([0, 0, 0]);
  expect(await pixel(page, 160, 90)).toEqual([0, 0, 0]);
  await page.keyboard.press("ControlOrMeta+z");
  await expect.poll(() => pixel(page, 160, 90)).not.toEqual([0, 0, 0]);

  // Opacity 0 makes the layer disappear.
  await page.getByRole("tab", { name: "Blending" }).click();
  const opacity = page.getByLabel("Opacity", { exact: true }).first();
  await opacity.fill("0");
  await opacity.press("Enter");
  await expect.poll(() => pixel(page, 160, 90)).toEqual([0, 0, 0]);
});

test("text: add, restyle through the inspector, keyframe a property", async ({ page }) => {
  await projectWithClip(page);
  await page.getByRole("tab", { name: "Text" }).first().click();
  await page.getByRole("button", { name: "Add Default text to timeline" }).click({ force: true });
  await expect(clips(page)).toHaveCount(2);
  const redBefore = await countColor(page, { r: [230, 255], g: [0, 40], b: [0, 40] });

  await page.getByLabel("Color", { exact: true }).fill("#ff0000");
  await page.getByLabel("Color", { exact: true }).press("Enter");
  await expect.poll(() => countColor(page, { r: [230, 255], g: [0, 40], b: [0, 40] })).toBeGreaterThan(redBefore + 50);

  // Larger font size grows the text.
  const before = await countColor(page, { r: [230, 255], g: [0, 40], b: [0, 40] });
  const size = page.getByLabel("Font size");
  await size.fill("30");
  await size.press("Enter");
  await expect.poll(() => countColor(page, { r: [230, 255], g: [0, 40], b: [0, 40] })).toBeGreaterThan(before);

  // Keyframing shows a diamond on the selected clip and survives undo/redo.
  await page.getByRole("tab", { name: "Blending" }).click();
  await page.getByRole("button", { name: "Add Opacity keyframe" }).click();
  await expect(page.locator(".clip__keyframe").first()).toBeVisible();
  await page.keyboard.press("ControlOrMeta+z");
  await expect(page.locator(".clip__keyframe")).toHaveCount(0);
  await page.keyboard.press("ControlOrMeta+Shift+z");
  await expect(page.locator(".clip__keyframe").first()).toBeVisible();
});

test("ruler seeks, shortcuts drive the playhead, shortcuts dialog rebinds a key", async ({ page }) => {
  await projectWithClip(page);
  const seconds = () => page.evaluate(() => Number(document.querySelector(".playhead")?.getAttribute("data-seconds")));
  const ruler = page.getByRole("slider", { name: "Timeline ruler" });
  const box = (await ruler.boundingBox())!;
  await page.mouse.click(box.x + 160, box.y + 10);
  await expect.poll(seconds).toBeGreaterThan(1);
  await page.keyboard.press("Home");
  await expect.poll(seconds).toBe(0);
  await page.keyboard.press("ArrowRight");
  await expect.poll(seconds).toBeCloseTo(1 / 30, 2);
  await page.keyboard.press("End");
  await expect.poll(seconds).toBeCloseTo(4, 1);

  await page.getByRole("button", { name: "Project menu" }).click();
  await page.getByRole("menuitem", { name: "Keyboard shortcuts" }).click();
  const dialog = page.getByRole("dialog", { name: "Keyboard shortcuts" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: /Rebind Split at playhead/ }).click();
  await page.keyboard.press("x");
  await expect(dialog.getByRole("button", { name: /Rebind Split at playhead, currently X/ })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();

  await page.keyboard.press("Home");
  await page.keyboard.press("l");
  await clips(page).first().click();
  await page.keyboard.press("s");
  await expect(clips(page)).toHaveCount(1);
  await page.keyboard.press("x");
  await expect(clips(page)).toHaveCount(2);
});

test("projects page: rename, duplicate, search, delete", async ({ page }) => {
  await page.goto("/#/projects");
  await page.getByRole("button", { name: "Create your first project" }).click();
  await page.getByLabel("Project name").fill("Holiday cut");
  await page.getByLabel("Project name").press("Enter");
  await expect(page.getByText("All changes saved")).toBeVisible({ timeout: 10_000 });
  await page.getByRole("button", { name: "Project menu" }).click();
  await page.getByRole("menuitem", { name: "Exit project" }).click();
  await expect(page.getByText("Holiday cut")).toBeVisible();

  await page.getByRole("button", { name: "Actions for Holiday cut", exact: true }).click({ force: true });
  await page.getByRole("menuitem", { name: "Duplicate" }).click();
  await expect(page.getByText("(1) Holiday cut")).toBeVisible();

  await page.getByLabel("Search projects").fill("(1)");
  await expect(page.getByText("(1) Holiday cut")).toBeVisible();
  await expect(page.locator(".project-card")).toHaveCount(1);
  await page.getByLabel("Search projects").fill("zzz");
  await expect(page.getByText("No results found")).toBeVisible();
  await page.getByRole("button", { name: "Clear search" }).click();

  await page.getByRole("button", { name: "Actions for (1) Holiday cut", exact: true }).click({ force: true });
  await page.getByRole("menuitem", { name: "Delete" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Delete project" }).click();
  await expect(page.locator(".project-card")).toHaveCount(1);
  await page.reload();
  await expect(page.getByText("Holiday cut")).toBeVisible();
});

test("playback schedules decoded audio on the audio clock", async ({ page }) => {
  await page.addInitScript(() => {
    const w = window as unknown as { __audioStarts: number };
    w.__audioStarts = 0;
    const original = AudioBufferSourceNode.prototype.start;
    AudioBufferSourceNode.prototype.start = function (...args: Parameters<typeof original>) {
      w.__audioStarts++;
      return original.apply(this, args);
    };
  });
  await page.goto("/#/projects");
  await page.getByRole("button", { name: "Create your first project" }).click();
  await makeWebm(page, { seconds: 3, hue: 40, name: "tone.webm", withAudio: true });
  await importGenerated(page);
  await page.getByRole("button", { name: "Add tone.webm to timeline" }).click({ force: true });
  await page.locator("body").click({ position: { x: 5, y: 5 } });
  await page.keyboard.press("Home");
  await page.keyboard.press("Space");
  await expect.poll(() => page.evaluate(() => (window as unknown as { __audioStarts: number }).__audioStarts), { timeout: 10_000 }).toBeGreaterThan(0);
  await page.keyboard.press("Space");
});

test("narrow viewports keep a usable editor and dark theme renders", async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 700 });
  await page.goto("/#/projects");
  await page.getByRole("button", { name: "Create your first project" }).click();
  await expect(page.getByRole("tab", { name: "Preview" })).toBeVisible();
  await page.getByRole("tab", { name: "Assets" }).click();
  await expect(page.getByRole("button", { name: "Import" })).toBeVisible();
  await makeWebm(page, { seconds: 2, hue: 10, name: "clip-a.webm" });
  await importGenerated(page);
  await page.getByRole("button", { name: "Add clip-a.webm to timeline" }).click({ force: true });
  await expect(clips(page)).toHaveCount(1);
  await page.getByRole("button", { name: /Switch to dark theme/ }).click();
  expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe("dark");
  await page.screenshot({ path: "e2e/.artifacts/narrow-dark.png" });
  expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(false);
});

test("project settings: aspect ratio and background change the composition; zoom keeps clip time", async ({ page }) => {
  await projectWithClip(page);
  const canvasSize = () => page.evaluate(() => {
    const c = document.querySelector<HTMLCanvasElement>(".preview__scene canvas");
    return [c!.width, c!.height];
  });
  expect(await canvasSize()).toEqual([320, 180]);

  await page.getByRole("tab", { name: "Settings" }).click();
  await page.getByRole("radio", { name: /9:16/ }).click();
  await expect.poll(canvasSize).toEqual([1080, 1920]);
  await page.getByRole("tab", { name: "Background" }).click();
  await page.getByRole("button", { name: "Colors" }).click();
  await page.getByRole("button", { name: "Background #ffffff" }).click();
  // Top-left of a portrait canvas is letterbox area around a 16:9 clip: now white.
  await expect.poll(() => pixel(page, 5, 5)).toEqual([255, 255, 255]);
  await page.keyboard.press("ControlOrMeta+z");
  await expect.poll(() => pixel(page, 5, 5)).toEqual([0, 0, 0]);

  // Zooming changes pixels per second but never the clip's time span.
  const before = await clips(page).first().evaluate((el) => [el.getAttribute("data-start"), el.getAttribute("data-duration"), el.getBoundingClientRect().width]);
  await page.getByRole("button", { name: "Zoom in", exact: true }).click();
  await page.getByRole("button", { name: "Zoom in", exact: true }).click();
  const after = await clips(page).first().evaluate((el) => [el.getAttribute("data-start"), el.getAttribute("data-duration"), el.getBoundingClientRect().width]);
  expect(after[0]).toBe(before[0]);
  expect(after[1]).toBe(before[1]);
  expect(after[2] as number).toBeGreaterThan((before[2] as number) * 2);
});
