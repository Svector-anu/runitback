import { expect, test } from "@playwright/test";
import { makeStructuredWebm } from "./analysis-media";

const TOLERANCE_SECONDS = 0.15;

test.describe("media analysis on real decoded media", () => {
  test("finds the cuts, silence, loudness and shot colours of a known clip", async ({ page }) => {
    await page.goto("/");
    await makeStructuredWebm(page, {
      name: "structured.webm",
      blocks: [{ seconds: 2, rgb: [220, 30, 30] }, { seconds: 1, rgb: [30, 200, 50] }, { seconds: 2, rgb: [40, 60, 230] }],
      tones: [{ from: 0, to: 1.5 }, { from: 3, to: 5 }],
    });

    const result = await page.evaluate(async () => {
      const analysisUrl = "/src/platform/analysis/index.ts";
      const { analyzeMedia, MemoryAnalysisStore } = (await import(analysisUrl)) as typeof import("../src/platform/analysis");
      const file = window.__analysisFile as File;
      const info = { id: "a1", name: file.name, type: "video" as const, size: file.size, lastModified: file.lastModified };
      const store = new MemoryAnalysisStore();
      const phases = new Set<string>();
      let last = 0;
      let monotonic = true;
      const first = await analyzeMedia(file, info, {
        store,
        onProgress: (p) => {
          phases.add(p.phase);
          if (p.overall + 1e-9 < last) monotonic = false;
          last = p.overall;
        },
      });
      const t0 = performance.now();
      const second = await analyzeMedia(file, info, { store });
      return { first, cachedIdentical: JSON.stringify(first) === JSON.stringify(second), cachedMs: performance.now() - t0, phases: [...phases], monotonic, last };
    });

    const { first } = result;
    expect(first.hasAudio).toBe(true);
    expect(first.hasVideo).toBe(true);
    expect(first.durationSeconds).toBeGreaterThan(4.9);
    expect(first.durationSeconds).toBeLessThan(5.2);

    expect(first.sceneCuts).toHaveLength(2);
    expect(Math.abs((first.sceneCuts[0]?.time ?? 0) - 2)).toBeLessThan(TOLERANCE_SECONDS);
    expect(Math.abs((first.sceneCuts[1]?.time ?? 0) - 3)).toBeLessThan(TOLERANCE_SECONDS);

    const gap = first.silences.find((s) => s.start > 1 && s.end < 3.5);
    expect(gap, JSON.stringify(first.silences)).toBeDefined();
    expect(Math.abs((gap?.start ?? 0) - 1.5)).toBeLessThan(TOLERANCE_SECONDS);
    expect(Math.abs((gap?.end ?? 0) - 3)).toBeLessThan(TOLERANCE_SECONDS);

    expect(first.shots).toHaveLength(3);
    const expected: Array<[number, number, number]> = [[220, 30, 30], [30, 200, 50], [40, 60, 230]];
    first.shots.forEach((shot, i) => {
      const hex = shot.dominantColors[0] ?? "#000000";
      const rgb = [1, 3, 5].map((o) => parseInt(hex.slice(o, o + 2), 16));
      const target = expected[i] as [number, number, number];
      expect(Math.hypot(rgb[0]! - target[0], rgb[1]! - target[1], rgb[2]! - target[2])).toBeLessThan(40);
    });
    expect(first.shots.every((s) => s.motion === "low")).toBe(true);

    expect(first.loudness?.peakDb).toBeGreaterThan(-12);
    expect(first.loudness?.peakDb).toBeLessThan(-8);
    expect(first.loudness?.integratedApproxDb).toBeGreaterThan(-16);
    expect(first.loudness?.integratedApproxDb).toBeLessThan(-11);

    expect(result.cachedIdentical).toBe(true);
    expect(result.cachedMs).toBeLessThan(100);
    expect(result.phases).toEqual(expect.arrayContaining(["audio", "video", "done"]));
    expect(result.monotonic).toBe(true);
  });

  test("reports nothing for a static clip with a steady tone", async ({ page }) => {
    await page.goto("/");
    await makeStructuredWebm(page, { name: "steady.webm", blocks: [{ seconds: 4, rgb: [120, 120, 120] }], tones: [{ from: 0, to: 4 }] });
    const analysis = await page.evaluate(async () => {
      const analysisUrl = "/src/platform/analysis/index.ts";
      const { analyzeMedia } = (await import(analysisUrl)) as typeof import("../src/platform/analysis");
      const file = window.__analysisFile as File;
      return analyzeMedia(file, { id: "a2", name: file.name, type: "video", size: file.size, lastModified: file.lastModified });
    });
    expect(analysis.sceneCuts).toEqual([]);
    expect(analysis.silences).toEqual([]);
    expect(analysis.shots).toHaveLength(1);
  });

  test("honours an abort signal", async ({ page }) => {
    await page.goto("/");
    await makeStructuredWebm(page, { name: "abort.webm", blocks: [{ seconds: 3, rgb: [90, 90, 90] }], tones: [{ from: 0, to: 3 }] });
    const name = await page.evaluate(async () => {
      const analysisUrl = "/src/platform/analysis/index.ts";
      const { analyzeMedia } = (await import(analysisUrl)) as typeof import("../src/platform/analysis");
      const file = window.__analysisFile as File;
      const controller = new AbortController();
      controller.abort();
      try {
        await analyzeMedia(file, { id: "a3", name: file.name, type: "video", size: file.size, lastModified: file.lastModified }, { signal: controller.signal });
        return "resolved";
      } catch (error) {
        return error instanceof DOMException ? error.name : "other";
      }
    });
    expect(name).toBe("AbortError");
  });

  test("renders a labelled contact sheet from decoded frames within the size cap", async ({ page }) => {
    await page.goto("/");
    await makeStructuredWebm(page, {
      name: "sheet.webm",
      blocks: [{ seconds: 2, rgb: [220, 30, 30] }, { seconds: 1, rgb: [30, 200, 50] }, { seconds: 2, rgb: [40, 60, 230] }],
      tones: [{ from: 0, to: 5 }],
    });
    const sheet = await page.evaluate(async () => {
      const sheetUrl = "/src/render/contact-sheet.ts";
      const { renderContactSheet } = (await import(sheetUrl)) as typeof import("../src/render/contact-sheet");
      const framesUrl = "/src/platform/video-frames.ts";
      const { VideoFrameCache } = (await import(framesUrl)) as typeof import("../src/platform/video-frames");
      const file = window.__analysisFile as File;
      const cache = new VideoFrameCache(() => file);
      const times = [0.5, 1.5, 2.5, 4];
      try {
        const result = await renderContactSheet({
          times, columns: 2, cell: { width: 1000, height: 562 },
          frameAt: async (t) => (await cache.getFrame("m", t)) as OffscreenCanvas | HTMLCanvasElement | null,
        });
        const bitmap = await createImageBitmap(result.blob);
        const probe = new OffscreenCanvas(bitmap.width, bitmap.height);
        const ctx = probe.getContext("2d") as OffscreenCanvasRenderingContext2D;
        ctx.drawImage(bitmap, 0, 0);
        const centre = result.plan.cells.map((c) => Array.from(ctx.getImageData(Math.round(c.x + c.width / 2), Math.round(c.y + c.height / 3), 1, 1).data.slice(0, 3)));
        return { type: result.blob.type, bytes: result.blob.size, width: bitmap.width, height: bitmap.height, labels: result.plan.cells.map((c) => c.label), centre };
      } finally {
        await cache.dispose();
      }
    });
    expect(sheet.type).toBe("image/jpeg");
    expect(sheet.bytes).toBeGreaterThan(1000);
    expect(Math.max(sheet.width, sheet.height)).toBeLessThanOrEqual(1568);
    expect(sheet.labels).toEqual(["00:00.50", "00:01.50", "00:02.50", "00:04.00"]);
    const [red, redAgain, green, blue] = sheet.centre as [number[], number[], number[], number[]];
    expect(red[0]).toBeGreaterThan(150);
    expect(redAgain[0]).toBeGreaterThan(150);
    expect(green[1]).toBeGreaterThan(150);
    expect(blue[2]).toBeGreaterThan(150);
  });
});
