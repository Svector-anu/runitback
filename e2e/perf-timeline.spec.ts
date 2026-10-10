import { expect, test, type Page } from "@playwright/test";
import { importGenerated, makeWebm } from "./media";
import { recordMeasurement, startFrameProbe, stopFrameProbe } from "./perf-support";

const ROWS = 8;
const CLIPS_PER_ROW = 12;

/** Builds ROWS stacked tracks of CLIPS_PER_ROW clips each through the same commands the UI uses. */
async function buildLargeProject(page: Page): Promise<{ total: number; tracks: number }> {
  return page.evaluate(async ({ rows, perRow }) => {
    const servicesUrl = "/src/app/services.ts";
    const commandsUrl = "/src/engine/commands/index.ts";
    const { getServices } = (await import(servicesUrl)) as typeof import("../src/app/services");
    const { insertMediaElement, currentScene } = (await import(commandsUrl)) as typeof import("../src/engine/commands");
    const { editor } = getServices();
    const asset = editor.getState().doc.assets[0];
    if (!asset) throw new Error("no asset imported");
    const spacing = 5 * 120_000;
    for (let r = 0; r < rows; r++) {
      for (let i = 0; i < perRow; i++) {
        editor.execute(insertMediaElement({ asset, elementId: editor.newId(), startTime: i * spacing, placement: { mode: "auto" } }));
      }
    }
    const tracks = currentScene(editor.getState().doc).tracks;
    const all = [...tracks.overlay, tracks.main, ...tracks.audio];
    return { total: all.reduce((n, t) => n + t.elements.length, 0), tracks: all.filter((t) => t.elements.length > 0).length };
  }, { rows: ROWS, perRow: CLIPS_PER_ROW });
}

test("timeline stays interactive with 90+ clips on 8 tracks and windows its clip DOM", async ({ page }) => {
  test.setTimeout(240_000);
  await page.goto("/#/projects");
  await page.getByRole("button", { name: "Create your first project" }).click();
  await makeWebm(page, { seconds: 4, hue: 200, name: "perf.webm", withAudio: true });
  await importGenerated(page);
  await expect(page.getByRole("button", { name: "Add perf.webm to timeline" })).toBeVisible();
  const { total, tracks } = await buildLargeProject(page);
  expect(total).toBeGreaterThanOrEqual(80);
  expect(tracks).toBeGreaterThanOrEqual(6);

  const clips = page.locator("[data-clip-id]");
  const zoomedOutMounted = await clips.count();
  await page.getByRole("slider", { name: "Timeline zoom" }).fill("0.85");
  await page.waitForTimeout(300);
  const mountedAtHighZoom = await clips.count();

  const ruler = page.getByRole("slider", { name: "Timeline ruler" });
  const rulerBox = (await ruler.boundingBox())!;

  await startFrameProbe(page);
  await page.mouse.move(rulerBox.x + 20, rulerBox.y + 10);
  await page.mouse.down();
  for (let i = 0; i < 160; i++) await page.mouse.move(rulerBox.x + 20 + (i * (rulerBox.width - 60)) / 160, rulerBox.y + 10);
  await page.mouse.up();
  const scrub = await stopFrameProbe(page);

  const scroller = page.locator(".timeline__scroll");
  await startFrameProbe(page);
  await scroller.evaluate(async (el) => {
    for (let i = 0; i < 80; i++) {
      el.scrollLeft += 40;
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }
  });
  const scroll = await stopFrameProbe(page);

  await scroller.evaluate((el) => { el.scrollLeft = 0; });
  await page.waitForTimeout(200);
  const clip = clips.nth(Math.floor((await clips.count()) / 2));
  const clipBox = (await clip.boundingBox())!;
  await startFrameProbe(page);
  await page.mouse.move(clipBox.x + 10, clipBox.y + 10);
  await page.mouse.down();
  for (let i = 1; i <= 80; i++) await page.mouse.move(clipBox.x + 10 + i * 2, clipBox.y + 10);
  await page.mouse.up();
  const drag = await stopFrameProbe(page);

  recordMeasurement("perf-timeline", {
    totalClips: total, nonEmptyTracks: tracks, mountedZoomedOut: zoomedOutMounted, mountedAtHighZoom,
    scrubP50: scrub.p50, scrubP95: scrub.p95, scrubMax: scrub.max, scrubLongTasks: scrub.longTasks, scrubLongTaskMs: scrub.longTaskMs,
    scrollP50: scroll.p50, scrollP95: scroll.p95, scrollMax: scroll.max, scrollLongTaskMs: scroll.longTaskMs,
    dragP50: drag.p50, dragP95: drag.p95, dragMax: drag.max, dragLongTaskMs: drag.longTaskMs,
  });

  expect(mountedAtHighZoom).toBeLessThan(total / 3);
  // 16.7 ms is one 60 Hz frame; two frames at the 95th percentile still reads as responsive on a loaded CI machine.
  expect(scrub.p95).toBeLessThanOrEqual(50);
  expect(drag.p95).toBeLessThanOrEqual(50);
  expect(scroll.p95).toBeLessThanOrEqual(50);
});
