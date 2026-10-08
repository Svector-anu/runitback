import { expect, test } from "@playwright/test";
import { importGenerated, makeWebm } from "./media";
import fs from "node:fs";

test("exported file reflects the edited timeline (not the source)", async ({ page }) => {
  await page.goto("/#/projects");
  await page.getByRole("button", { name: "Create your first project" }).click();
  await makeWebm(page, { seconds: 4, hue: 10, name: "clip-a.webm", withAudio: true });
  await importGenerated(page);
  await page.getByRole("button", { name: "Add clip-a.webm to timeline" }).click({ force: true });
  await expect(page.locator("[data-clip-id]")).toHaveCount(1);

  // Keep only the first 2 seconds: seek to 2s, split and drop the right half.
  await page.locator("body").click({ position: { x: 5, y: 5 } });
  await page.keyboard.press("Home");
  await page.keyboard.press("l");
  await page.keyboard.press("l");
  await page.locator("[data-clip-id]").first().click();
  await page.keyboard.press("w");
  await expect.poll(() => page.locator("[data-clip-id]").first().getAttribute("data-duration")).toBe(String(2 * 120000));

  await page.getByRole("button", { name: "Export", exact: true }).first().click();
  await page.getByRole("button", { name: "Format" }).click();
  await page.getByLabel("WebM (VP9)").check();
  const downloadPromise = page.waitForEvent("download", { timeout: 90_000 });
  await page.getByRole("dialog", { name: "Export project" }).getByRole("button", { name: "Export" }).click();
  const download = await downloadPromise;
  const path = await download.path();
  expect(download.suggestedFilename()).toBe("New project.webm");
  const bytes = fs.readFileSync(path);
  expect(bytes.length).toBeGreaterThan(1000);

  const info = await page.evaluate(async (data) => {
    const { Input, BlobSource, ALL_FORMATS, CanvasSink } = await import("/node_modules/.vite/deps/mediabunny.js");
    const blob = new Blob([new Uint8Array(data)], { type: "video/webm" });
    const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS });
    const video = await input.getPrimaryVideoTrack();
    const audio = await input.getPrimaryAudioTrack();
    const duration = await input.computeDuration();
    const sink = new CanvasSink(video!);
    const frame = await sink.getCanvas(0.5);
    const c = frame!.canvas as OffscreenCanvas | HTMLCanvasElement;
    const ctx = (c as HTMLCanvasElement).getContext("2d")!;
    const px = Array.from(ctx.getImageData(5, 5, 1, 1).data.slice(0, 3));
    return { duration, width: await video!.getDisplayWidth(), height: await video!.getDisplayHeight(), hasAudio: audio !== null, px };
  }, [...bytes]);

  expect(info.duration).toBeGreaterThan(1.8);
  expect(info.duration).toBeLessThan(2.3);
  expect(info.width).toBe(320);
  expect(info.height).toBe(180);
  expect(info.hasAudio).toBe(true);
  // Source frame at 0.5s is hsl(10+45, 80%, 50%) => red/orange: red channel dominates blue.
  expect(info.px[0]).toBeGreaterThan(info.px[2] ?? 0);
});
