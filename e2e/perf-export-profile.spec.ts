import { expect, test, type Page } from "@playwright/test";
import { ensureH264, recordMeasurement, sampleHeap } from "./perf-support";

// Playwright's bundled Chromium has no H.264 decoder; the installed Chrome does.
test.use({ channel: "chrome" });

// Per-stage export timings (decode, compose, capture, encode) at 1080p and 4K, for docs/PERFORMANCE.md.
// EXPORT_SYNC_GPU=1 forces a GPU sync after compositing so `composeMs` is real work, not queued work (slower overall).
const SYNC_GPU = process.env.EXPORT_SYNC_GPU === "1";

const CASES = [
  { label: "1080p", name: "fhd-30fps-8s.mp4", width: 1920, height: 1080 },
  { label: "4k", name: "uhd-30fps-8s.mp4", width: 3840, height: 2160 },
] as const;

async function openProject(page: Page): Promise<void> {
  await page.goto("/#/projects");
  await page.getByRole("button", { name: "Create your first project" }).click();
  await expect(page.getByLabel("Project name")).toBeVisible();
}

for (const item of CASES) {
  test(`export stage timings at ${item.label}`, async ({ page }) => {
    test.setTimeout(600_000);
    const path = ensureH264({ name: item.name, width: item.width, height: item.height, fps: 30, seconds: 8 });
    await openProject(page);
    await page.waitForSelector('input[aria-label="Import media files"]', { state: "attached", timeout: 20_000 });
    await page.setInputFiles('input[aria-label="Import media files"]', path);
    await page.getByRole("button", { name: `Add ${item.name} to timeline` }).click({ force: true });
    await expect(page.locator("[data-clip-id]")).toHaveCount(1);

    const stopHeap = await sampleHeap(page);
    const result = await page.evaluate(async (syncGpu) => {
      const servicesUrl = "/src/app/services.ts";
      const exporterUrl = "/src/export/exporter.ts";
      const { getServices } = (await import(servicesUrl)) as typeof import("../src/app/services");
      const exporter = (await import(exporterUrl)) as typeof import("../src/export/exporter");
      const { editor, runtime } = getServices();
      const timings = exporter.emptyExportTimings();
      timings.syncGpu = syncGpu;
      const start = performance.now();
      const out = await exporter.exportProject({
        doc: editor.getState().doc, getBlob: runtime.getBlob, timings,
        options: { format: "mp4", quality: "high", includeAudio: true },
      });
      return { timings, wallMs: performance.now() - start, frames: out.frameCount, bytes: out.blob.size, codec: out.videoCodec, width: out.width, height: out.height };
    }, SYNC_GPU);
    const heap = await stopHeap();
    const round = (n: number): number => Math.round(n);
    const t = result.timings;
    recordMeasurement(`perf-export-profile-${item.label}${SYNC_GPU ? "-sync" : ""}`, {
      size: `${result.width}x${result.height}`, codec: result.codec, frames: result.frames,
      wallMs: round(result.wallMs), fps: Math.round((result.frames / (result.wallMs / 1000)) * 10) / 10,
      planMs: round(t.planMs), decodeMs: round(t.decodeMs), composeMs: round(t.composeMs), audioMs: round(t.audioMs),
      captureMs: round(t.captureMs), encodeMs: round(t.encodeMs), peakJsHeapMb: heap.peakMb, outputMb: Math.round(result.bytes / 1e5) / 10,
    });
    expect(result.frames).toBe(240);
  });
}
