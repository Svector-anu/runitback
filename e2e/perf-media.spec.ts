import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import { mediabunnyModuleUrl } from "./media";
import { ensureH264, FFMPEG_SKIP_REASON, findFfmpeg, recordMeasurement, sampleHeap } from "./perf-support";

// Playwright's bundled Chromium has no H.264 decoder; the installed Chrome does.
test.use({ channel: "chrome" });
test.skip(findFfmpeg() === null, FFMPEG_SKIP_REASON);

async function openProject(page: Page): Promise<void> {
  await page.goto("/#/projects");
  await page.getByRole("button", { name: "Create your first project" }).click();
  await expect(page.getByLabel("Project name")).toBeVisible();
}

async function importFile(page: Page, path: string): Promise<void> {
  await page.waitForSelector('input[aria-label="Import media files"]', { state: "attached", timeout: 20_000 });
  await page.setInputFiles('input[aria-label="Import media files"]', path);
}

interface DecodeTimes { first: number; sequentialMean: number; seekMean: number; width: number; height: number }

/** Decodes through the runtime the preview uses and reports milliseconds per frame. */
async function measureDecode(page: Page): Promise<DecodeTimes> {
  return page.evaluate(async () => {
    const servicesUrl = "/src/app/services.ts";
    const { getServices } = (await import(servicesUrl)) as typeof import("../src/app/services");
    const { editor, runtime } = getServices();
    const asset = editor.getState().doc.assets[0];
    if (!asset) throw new Error("no asset");
    const seconds = (asset.duration ?? 0) / 120_000;
    const timed = async (t: number): Promise<{ ms: number; width: number }> => {
      const start = performance.now();
      const frame = (await runtime.video.getFrame(asset.id, t)) as HTMLCanvasElement | null;
      return { ms: performance.now() - start, width: frame?.width ?? 0 };
    };
    const first = await timed(0.5);
    let sequential = 0;
    for (let i = 0; i < 60; i++) sequential += (await timed(0.5 + (i + 1) / 30)).ms;
    let seek = 0;
    for (let i = 0; i < 20; i++) seek += (await timed(((i * 7919) % 1000) / 1000 * (seconds - 1))).ms;
    const last = await timed(1);
    return { first: first.ms, sequentialMean: sequential / 60, seekMean: seek / 20, width: last.width, height: asset.height ?? 0 };
  });
}

const round = (n: number): number => Math.round(n * 10) / 10;

test("a 4K H.264 source imports, previews and exports", async ({ page }) => {
  test.skip(!!process.env.CI && !process.env.RUN_4K, "the 4K export exhausts the Node heap on 7 GB CI runners; set RUN_4K=1 to force");
  test.setTimeout(600_000);
  const path = ensureH264({ name: "uhd-30fps-8s.mp4", width: 3840, height: 2160, fps: 30, seconds: 8 });
  await openProject(page);
  await importFile(page, path);
  await page.getByRole("button", { name: "Add uhd-30fps-8s.mp4 to timeline" }).click({ force: true });
  await expect(page.locator("[data-clip-id]")).toHaveCount(1);

  const canvasSize = await page.evaluate(async () => {
    const servicesUrl = "/src/app/services.ts";
    const { getServices } = (await import(servicesUrl)) as typeof import("../src/app/services");
    return getServices().editor.getState().doc.settings.canvasSize;
  });

  const previewPainted = await page.waitForFunction(() => {
    const canvas = document.querySelector<HTMLCanvasElement>('canvas[aria-label="Preview of the composition"]');
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return false;
    const small = ctx.getImageData(0, 0, canvas.width, canvas.height, { colorSpace: "srgb" });
    let lit = 0;
    for (let i = 0; i < small.data.length; i += 4 * 9973) lit += (small.data[i] ?? 0) + (small.data[i + 1] ?? 0) + (small.data[i + 2] ?? 0) > 60 ? 1 : 0;
    return lit > 20;
  }, undefined, { timeout: 30_000 }).then(() => true, () => false);

  const decode = await measureDecode(page);
  const stopHeap = await sampleHeap(page);

  await page.getByRole("button", { name: "Export", exact: true }).first().click();
  const downloadPromise = page.waitForEvent("download", { timeout: 540_000 });
  const startedAt = Date.now();
  await page.getByRole("dialog", { name: "Export project" }).getByRole("button", { name: "Export" }).click();
  const download = await downloadPromise;
  const exportSeconds = (Date.now() - startedAt) / 1000;
  const heap = await stopHeap();
  const bytes = fs.readFileSync((await download.path())!);

  const url = await mediabunnyModuleUrl(page);
  const output = await page.evaluate(async ({ data, moduleUrl }) => {
    const { Input, BlobSource, ALL_FORMATS, CanvasSink } = (await import(moduleUrl)) as typeof import("mediabunny");
    const input = new Input({ source: new BlobSource(new Blob([new Uint8Array(data)], { type: "video/mp4" })), formats: ALL_FORMATS });
    const video = await input.getPrimaryVideoTrack();
    const frame = await new CanvasSink(video!).getCanvas(2);
    return { width: await video!.getDisplayWidth(), height: await video!.getDisplayHeight(), duration: await input.computeDuration(), decoded: frame !== null };
  }, { data: [...bytes], moduleUrl: url });

  recordMeasurement("perf-media-4k", {
    canvas: `${canvasSize.width}x${canvasSize.height}`, previewPainted,
    firstFrameMs: round(decode.first), sequentialFrameMs: round(decode.sequentialMean), randomSeekMs: round(decode.seekMean),
    decodedWidth: decode.width, exportSeconds: round(exportSeconds), exportFramesPerSecond: round((8 * 30) / exportSeconds),
    peakJsHeapMb: heap.peakMb, outputMb: round(bytes.length / 1e6), outputSize: `${output.width}x${output.height}`,
  });
  expect(previewPainted).toBe(true);
  expect(output.width).toBe(canvasSize.width);
  expect(output.height).toBe(canvasSize.height);
  expect(output.decoded).toBe(true);
  expect(output.duration).toBeGreaterThan(7);
});

test("scrubbing a 10-minute source neither leaks nor grows, and closing the project releases everything", async ({ page }) => {
  test.setTimeout(600_000);
  const path = ensureH264({ name: "sd-15fps-600s.mp4", width: 640, height: 360, fps: 15, seconds: 600 });
  await openProject(page);
  await importFile(page, path);
  await page.getByRole("button", { name: "Add sd-15fps-600s.mp4 to timeline" }).click({ force: true });
  await expect(page.locator("[data-clip-id]")).toHaveCount(1);

  const session = await page.context().newCDPSession(page);
  const collectedHeapMb = async (): Promise<number> => {
    await session.send("HeapProfiler.collectGarbage");
    const { metrics } = await session.send("Performance.getMetrics");
    return Math.round(((metrics.find((m) => m.name === "JSHeapUsedSize")?.value ?? 0) / 1e6) * 10) / 10;
  };
  await session.send("Performance.enable");

  const scrub = (count: number, seed: number): Promise<{ ms: number[]; stats: Record<string, number> }> => page.evaluate(async ({ count, seed }) => {
    const servicesUrl = "/src/app/services.ts";
    const { getServices } = (await import(servicesUrl)) as typeof import("../src/app/services");
    const timeUrl = "/src/engine/time/index.ts";
    const { mediaTimeFromSeconds } = (await import(timeUrl)) as typeof import("../src/engine/time");
    const { editor, runtime } = getServices();
    (window as unknown as { __runtime: unknown }).__runtime = runtime;
    const asset = editor.getState().doc.assets[0];
    if (!asset) throw new Error("no asset");
    const seconds = (asset.duration ?? 0) / 120_000;
    runtime.objectUrl(asset.id);
    const ms: number[] = [];
    let x = seed;
    for (let i = 0; i < count; i++) {
      x = (x * 1103515245 + 12345) % 2147483648;
      const t = (x / 2147483648) * (seconds - 1);
      editor.playback.seek(mediaTimeFromSeconds(t), performance.now());
      const start = performance.now();
      await runtime.video.getFrame(asset.id, t);
      ms.push(performance.now() - start);
    }
    return { ms, stats: runtime.stats() as unknown as Record<string, number> };
  }, { count, seed });

  const warm = await scrub(40, 1);
  const heapAfterWarm = await collectedHeapMb();
  const long = await scrub(300, 2);
  const heapAfterLong = await collectedHeapMb();

  const sorted = [...long.ms].sort((a, b) => a - b);
  const closed = await (async (): Promise<Record<string, number>> => {
    await page.goto("/#/projects");
    await expect.poll(() => page.evaluate(() => (window as unknown as { __runtime: { stats(): Record<string, number> } }).__runtime.stats().videoDecoders)).toBe(0);
    return page.evaluate(() => (window as unknown as { __runtime: { stats(): Record<string, number> } }).__runtime.stats());
  })();

  recordMeasurement("perf-media-long-scrub", {
    seeks: 340, seekP50Ms: round(sorted[Math.floor(sorted.length / 2)] ?? 0), seekP95Ms: round(sorted[Math.floor(sorted.length * 0.95)] ?? 0),
    heapMbAfter40: heapAfterWarm, heapMbAfter340: heapAfterLong, videoDecodersDuringScrub: long.stats.videoDecoders ?? -1,
    objectUrlsDuringScrub: long.stats.objectUrls ?? -1, imageBitmapsDuringScrub: long.stats.imageBitmaps ?? -1,
    decodersAfterClose: closed.videoDecoders ?? -1, objectUrlsAfterClose: closed.objectUrls ?? -1, blobsAfterClose: closed.blobs ?? -1,
  });
  expect(warm.stats.videoDecoders).toBe(1);
  expect(long.stats.videoDecoders).toBe(1);
  expect(long.stats.imageBitmaps).toBe(0);
  expect(long.stats.objectUrls).toBeLessThanOrEqual(1);
  expect(heapAfterLong - heapAfterWarm).toBeLessThan(40);
  expect(closed).toEqual({ blobs: 0, objectUrls: 0, videoDecoders: 0, imageBitmaps: 0 });
});
