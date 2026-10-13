import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import { importGenerated, makeWebm, mediabunnyModuleUrl } from "./media";

// Cross-browser smoke subset (docs/BROWSERS.md). Not part of the default `pnpm e2e` run: select it with
// PLAYWRIGHT_PROJECT=chrome|firefox|webkit, e.g. `PLAYWRIGHT_PROJECT=webkit pnpm exec playwright test`.

const clips = (page: Page) => page.locator("[data-clip-id]");
const currentSeconds = (page: Page) => page.evaluate(() => Number(document.querySelector(".playhead")?.getAttribute("data-seconds")));
const previewPixel = (page: Page) => page.evaluate(() => {
  const canvas = document.querySelector<HTMLCanvasElement>(".preview__scene canvas");
  if (!canvas) throw new Error("no preview canvas");
  const ctx = canvas.getContext("2d") as CanvasRenderingContext2D;
  return Array.from(ctx.getImageData(10, 10, 1, 1).data.slice(0, 3));
});

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  return errors;
}

async function projectWithClip(page: Page, input: { seconds: number; withAudio: boolean }): Promise<void> {
  await page.goto("/#/projects");
  await page.getByRole("button", { name: "Create your first project" }).click();
  await expect(page.getByLabel("Project name")).toBeVisible();
  await makeWebm(page, { seconds: input.seconds, hue: 10, name: "clip-a.webm", withAudio: input.withAudio });
  await importGenerated(page);
  await expect(page.getByRole("group", { name: /video clip-a.webm/ })).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "Add clip-a.webm to timeline" }).click({ force: true });
  await expect(clips(page)).toHaveCount(1);
}

interface DecodedExport { duration: number; width: number; height: number; hasAudio: boolean; videoCodec: string | null; audioCodec: string | null }

async function decodeExport(page: Page, bytes: Buffer, mimeType: string): Promise<DecodedExport> {
  const moduleUrl = await mediabunnyModuleUrl(page);
  return page.evaluate(async ({ data, moduleUrl, mimeType }) => {
    const { Input, BlobSource, ALL_FORMATS } = (await import(moduleUrl)) as typeof import("mediabunny");
    const input = new Input({ source: new BlobSource(new Blob([new Uint8Array(data)], { type: mimeType })), formats: ALL_FORMATS });
    const video = await input.getPrimaryVideoTrack();
    const audio = await input.getPrimaryAudioTrack();
    return {
      duration: await input.computeDuration(), width: await video!.getDisplayWidth(), height: await video!.getDisplayHeight(),
      hasAudio: audio !== null, videoCodec: await video!.getCodec(), audioCodec: audio ? await audio.getCodec() : null,
    };
  }, { data: [...bytes], moduleUrl, mimeType });
}

test("@cross landing page renders and links into the app", async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await page.goto("/#/projects");
  await expect(page.getByRole("button", { name: "Create your first project" })).toBeVisible();
  expect(errors).toEqual([]);
});

test("@cross import, place, play, split and undo", async ({ page }) => {
  const errors = collectErrors(page);
  await projectWithClip(page, { seconds: 4, withAudio: true });
  await expect.poll(() => previewPixel(page)).not.toEqual([0, 0, 0]);
  const first = await previewPixel(page);

  await page.locator("body").click({ position: { x: 5, y: 5 } });
  await page.keyboard.press("Home");
  await page.keyboard.press("l");
  await expect.poll(() => currentSeconds(page)).toBeCloseTo(1, 1);
  await clips(page).first().click();
  await page.keyboard.press("s");
  await expect(clips(page)).toHaveCount(2);
  await page.keyboard.press("ControlOrMeta+z");
  await expect(clips(page)).toHaveCount(1);

  await page.keyboard.press("Home");
  await page.keyboard.press("Space");
  await page.waitForTimeout(1200);
  await page.keyboard.press("Space");
  expect(await currentSeconds(page)).toBeGreaterThan(0.5);
  await expect.poll(() => previewPixel(page)).not.toEqual(first);
  expect(errors).toEqual([]);
});

test("@cross WebM export decodes with the edited duration and audio", async ({ page }) => {
  test.setTimeout(180_000);
  await projectWithClip(page, { seconds: 4, withAudio: true });
  await page.getByRole("button", { name: "Export", exact: true }).first().click();
  await page.getByRole("button", { name: "Format" }).click();
  await page.getByLabel("WebM (VP9)").check();
  const downloadPromise = page.waitForEvent("download", { timeout: 120_000 });
  await page.getByRole("dialog", { name: "Export project" }).getByRole("button", { name: "Export" }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe("New project.webm");
  const bytes = fs.readFileSync((await download.path())!);
  expect(bytes.length).toBeGreaterThan(1000);
  const info = await decodeExport(page, bytes, "video/webm");
  expect(info.duration).toBeGreaterThan(3.7);
  expect(info.duration).toBeLessThan(4.3);
  expect([info.width, info.height]).toEqual([320, 180]);
  expect(info.hasAudio).toBe(true);
});

test("@cross MP4 export, or a precise message when the browser cannot encode it", async ({ page }) => {
  test.setTimeout(180_000);
  await projectWithClip(page, { seconds: 3, withAudio: true });
  const canEncodeAvc = await page.evaluate(async () => {
    try { return (await VideoEncoder.isConfigSupported({ codec: "avc1.42001f", width: 320, height: 180, bitrate: 1_000_000 })).supported === true; } catch { return false; }
  });
  await page.getByRole("button", { name: "Export", exact: true }).first().click();
  const dialog = page.getByRole("dialog", { name: "Export project" });
  const downloadPromise = page.waitForEvent("download", { timeout: 120_000 }).catch(() => null);
  await dialog.getByRole("button", { name: "Export" }).click();
  const download = await downloadPromise;
  if (!download) {
    expect(canEncodeAvc || (await page.getByText(/cannot encode|can't encode/i).count()) > 0).toBe(true);
    return;
  }
  const bytes = fs.readFileSync((await download.path())!);
  const info = await decodeExport(page, bytes, "video/mp4");
  expect(info.duration).toBeGreaterThan(2.7);
  expect(info.hasAudio).toBe(true);
  process.stdout.write(`[matrix] ${test.info().project.name} mp4 export: ${info.videoCodec}/${info.audioCodec}\n`);
});

test("@cross agent panel runs a scripted model turn and undoes it", async ({ page }) => {
  test.setTimeout(120_000);
  await page.addInitScript((key) => localStorage.setItem(key, "false"), "runitback:agent-ask-before-editing");
  await projectWithClip(page, { seconds: 3, withAudio: false });
  await page.evaluate(async () => {
    const url = "/src/app/agent/model-client.ts";
    const { ScriptedModelClient } = (await import(/* @vite-ignore */ url)) as typeof import("../src/app/agent/model-client");
    const use = (id: string, name: string, input: unknown) => ({ type: "tool_use" as const, id, name, input });
    (globalThis as unknown as { __agentModel?: unknown }).__agentModel = new ScriptedModelClient([
      { content: [use("c1", "split", { at: 1.5 })] },
      { content: [{ type: "text", text: "Cut the clip at 1.5s." }] },
    ]);
  });
  await page.getByRole("tab", { name: "Agent" }).click();
  const panel = page.getByTestId("agent-panel");
  await panel.getByLabel("Message to the agent").fill("Split at 1.5 seconds");
  await panel.getByRole("button", { name: "Send" }).click();
  await expect(panel.getByTestId("agent-assistant-text").last()).toContainText("Cut the clip");
  await expect(clips(page)).toHaveCount(2);
  await panel.getByRole("button", { name: "Undo agent changes" }).click();
  await expect(clips(page)).toHaveCount(1);
});

test("@cross a browser without video decoding gets a notice and a precise import error", async ({ page }) => {
  await page.addInitScript(() => { Reflect.deleteProperty(window, "VideoDecoder"); });
  await page.goto("/#/projects");
  await page.getByRole("button", { name: "Create your first project" }).click();
  const notice = page.getByTestId("browser-notice");
  await expect(notice).toContainText("can't decode video");
  await makeWebm(page, { seconds: 2, hue: 10, name: "clip-a.webm", withAudio: false });
  await importGenerated(page);
  await expect(page.getByText(/Your browser can't decode video/).nth(1)).toBeVisible();
  await notice.getByRole("button", { name: "Dismiss notice" }).click();
  await expect(notice).toHaveCount(0);
});

test("@cross capability report has no blockers and canvas filter detection matches reality", async ({ page }) => {
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const url = "/src/platform/capabilities.ts";
    const { reportCapabilities, probeEncoders } = (await import(/* @vite-ignore */ url)) as typeof import("../src/platform/capabilities");
    const report = reportCapabilities();
    const canvas = new OffscreenCanvas(40, 40);
    const ctx = canvas.getContext("2d") as OffscreenCanvasRenderingContext2D;
    const probe = new OffscreenCanvas(40, 40).getContext("2d") as OffscreenCanvasRenderingContext2D;
    probe.fillStyle = "#fff";
    probe.fillRect(15, 15, 10, 10);
    ctx.filter = "blur(4px)";
    ctx.drawImage(probe.canvas, 0, 0);
    const outside = ctx.getImageData(12, 20, 1, 1).data[3] ?? 0;
    return { report, blurSpreadsOutsideSquare: outside > 0, encoders: await probeEncoders({ width: 3840, height: 2160 }) };
  });
  process.stdout.write(`[matrix] ${test.info().project.name} ${JSON.stringify({ level: result.report.level, issues: result.report.issues.map((i) => i.id), offscreenFilterApplied: result.blurSpreadsOutsideSquare, encoders4k: result.encoders })}\n`);
  expect(result.report.issues.filter((issue) => issue.severity === "blocker")).toEqual([]);
  expect(result.report.capabilities.canvasFilter).toBe(result.blurSpreadsOutsideSquare);
});
