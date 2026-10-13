import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { clipAt, openEditorWithClips, previewPixels, readElements, seekSeconds, selectClip, setSlider, shot, undo, type Rgb } from "./ctl-support";

test.use({ channel: "chrome" });

const TICKS = 120_000;
const handle = (page: Page) => page.locator(".transition-handle");
const popover = (page: Page) => page.getByRole("dialog", { name: /Transition between/ });
const incoming = async (page: Page) => (await readElements(page)).find((e) => e.startTime > 0 && e.type === "video");
const centre = async (page: Page, seconds: number): Promise<Rgb> => {
  await seekSeconds(page, seconds);
  await expect.poll(async () => (await previewPixels(page, [[0.5, 0.5]]))[0]).toBeDefined();
  await page.waitForTimeout(250);
  return (await previewPixels(page, [[0.5, 0.5]]))[0] as Rgb;
};

test.beforeEach(async ({ page }) => {
  await openEditorWithClips(page, [{ name: "red.webm", color: "#ff0000", seconds: 4 }, { name: "blue.webm", color: "#0000ff", seconds: 4 }]);
});

test("a handle sits on the cut; Dissolve blends the preview; one undo per change", async ({ page }) => {
  await expect(handle(page)).toHaveCount(1);
  await expect(handle(page)).toHaveAttribute("data-has-transition", "false");
  await expect(handle(page)).toHaveAttribute("aria-label", /Add transition between red\.webm and blue\.webm/);
  const cut = await handle(page).boundingBox();
  const blueClip = await clipAt(page, 1).boundingBox();
  expect(cut && blueClip && Math.abs(cut.x + cut.width / 2 - blueClip.x) < 3).toBe(true);
  await shot(page, "transition-handle-idle", page.locator(".timeline"));

  const hardCut = await centre(page, 4);
  expect(hardCut[2]).toBeGreaterThan(200);

  await handle(page).click();
  await expect(popover(page)).toBeVisible();
  await expect(popover(page).getByRole("button")).toHaveCount(8);
  await shot(page, "transition-popover-empty");
  await popover(page).getByRole("button", { name: "Cross dissolve" }).click();
  await expect(handle(page)).toHaveAttribute("data-has-transition", "true");
  await expect(handle(page)).toHaveAttribute("aria-label", /Edit transition: Cross dissolve, 1\.00 seconds/);
  expect((await incoming(page))?.transition).toEqual({ type: "dissolve", duration: TICKS });

  await setSlider(page, "Transition duration slider", 1.5 * TICKS);
  await expect.poll(async () => (await incoming(page))?.transition?.duration).toBe(1.5 * TICKS);
  await shot(page, "transition-popover-dissolve");
  await page.keyboard.press("Escape");
  await expect(popover(page)).toHaveCount(0);

  const mid = await centre(page, 4);
  expect(mid[0]).toBeGreaterThan(60);
  expect(mid[2]).toBeGreaterThan(60);
  expect(mid[1]).toBeLessThan(60);
  await shot(page, "transition-dissolve-mid-editor");
  expect((await centre(page, 2.5))[0]).toBeGreaterThan(200);
  expect((await centre(page, 5.8))[2]).toBeGreaterThan(200);

  await undo(page);
  expect((await incoming(page))?.transition?.duration).toBe(TICKS);
  await undo(page);
  expect((await incoming(page))?.transition).toBeUndefined();
  await expect(handle(page)).toHaveAttribute("data-has-transition", "false");
});

test("the duration slider is clamped to half the shorter clip; changing type keeps the length; remove clears it", async ({ page }) => {
  await handle(page).click();
  await popover(page).getByRole("button", { name: "Zoom" }).click();
  const slider = page.getByRole("slider", { name: "Transition duration slider" });
  expect(await slider.getAttribute("max")).toBe(String(2 * TICKS));
  await setSlider(page, "Transition duration slider", 2 * TICKS);
  await popover(page).getByRole("button", { name: "Wipe left" }).click();
  expect((await incoming(page))?.transition).toEqual({ type: "wipe-left", duration: 2 * TICKS });
  await expect(popover(page).getByRole("button", { name: "Wipe left" })).toHaveAttribute("aria-pressed", "true");
  const typed = page.getByRole("textbox", { name: "Transition duration", exact: true });
  await typed.fill("30");
  await typed.press("Enter");
  await expect.poll(async () => (await incoming(page))?.transition?.duration).toBe(2 * TICKS);

  await popover(page).getByRole("button", { name: "Remove transition" }).click();
  await expect(popover(page)).toHaveCount(0);
  expect((await incoming(page))?.transition).toBeUndefined();
  await undo(page);
  expect((await incoming(page))?.transition?.type).toBe("wipe-left");
});

test("keyboard: the handle is focusable, Enter opens the editor, Escape closes it and returns focus", async ({ page }) => {
  await handle(page).focus();
  await page.keyboard.press("Enter");
  await expect(popover(page)).toBeVisible();
  await expect(popover(page).getByRole("button", { name: "Cross dissolve" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect.poll(async () => (await incoming(page))?.transition?.type).toBe("dissolve");
  await page.keyboard.press("Escape");
  await expect(popover(page)).toHaveCount(0);
  await expect(handle(page)).toBeFocused();
});

test("moving the clips apart removes the transition and its handle in the same undo step", async ({ page }) => {
  await handle(page).click();
  await popover(page).getByRole("button", { name: "Cross dissolve" }).click();
  await page.keyboard.press("Escape");
  await selectClip(page, 0);
  await page.keyboard.press("Delete");
  await expect(handle(page)).toHaveCount(0);
  await undo(page);
  await expect(handle(page)).toHaveCount(1);
  await expect(handle(page)).toHaveAttribute("data-has-transition", "true");
});

test("the exported video blends across the cut (decoded frame at the cut is neither red nor blue)", async ({ page }) => {
  test.setTimeout(180_000);
  await handle(page).click();
  await popover(page).getByRole("button", { name: "Cross dissolve" }).click();
  await page.keyboard.press("Escape");

  await page.getByRole("button", { name: "Export", exact: true }).first().click();
  await page.getByRole("button", { name: "Format" }).click();
  await page.getByLabel("WebM (VP9)").check();
  const downloadPromise = page.waitForEvent("download", { timeout: 120_000 });
  await page.getByRole("dialog", { name: "Export project" }).getByRole("button", { name: "Export" }).click();
  const bytes = readFileSync(await (await downloadPromise).path());

  const frames = await page.evaluate(async (data) => {
    const url = "/node_modules/.vite/deps/mediabunny.js";
    const { Input, BlobSource, ALL_FORMATS, CanvasSink } = (await import(/* @vite-ignore */ url)) as typeof import("mediabunny");
    const input = new Input({ source: new BlobSource(new Blob([new Uint8Array(data)], { type: "video/webm" })), formats: ALL_FORMATS });
    const sink = new CanvasSink((await input.getPrimaryVideoTrack())!);
    const out: number[][] = [];
    for (const t of [2.5, 4.0, 5.5]) {
      const frame = await sink.getCanvas(t);
      const ctx = (frame!.canvas as HTMLCanvasElement).getContext("2d")!;
      out.push(Array.from(ctx.getImageData(160, 90, 1, 1).data.slice(0, 3)));
    }
    return out;
  }, [...bytes]);
  expect(frames[0]![0]).toBeGreaterThan(200);
  expect(frames[2]![2]).toBeGreaterThan(200);
  expect(frames[1]![0]).toBeGreaterThan(60);
  expect(frames[1]![2]).toBeGreaterThan(60);
  expect(frames[1]![1]).toBeLessThan(70);
});
