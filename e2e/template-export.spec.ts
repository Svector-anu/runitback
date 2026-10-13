import { expect, test } from "@playwright/test";
import { mediabunnyModuleUrl } from "./media";

/**
 * Applies shipped templates to generated media in the real app modules, exports them with the real exporter and decodes
 * the file: the length must match the template and every sampled frame must have content (not black).
 */
const BROWSER = "/e2e/template-browser.ts";
type Browser = typeof import("./template-browser");

const FRAME_SECONDS = 1 / 30;
const MIN_LIT_FRACTION = 0.05;

const CASES = [
  { id: "kinetic-announcement", expectedSeconds: 15, times: [0.5, 2.5, 4.5, 6.5, 9, 13.5], width: 1080, height: 1920 },
  { id: "product-launch", expectedSeconds: 25, times: [1, 5, 12, 19, 22, 24.5], width: 1920, height: 1080 },
  { id: "kinetic-sentences", expectedSeconds: 19, times: [1, 4.5, 8, 12, 16.5, 18.5], width: 1920, height: 1080 },
  { id: "app-walkthrough", expectedSeconds: 25, times: [1.5, 6.5, 10, 16, 20, 24], width: 1920, height: 1080 },
  { id: "tilted-ui-tour", expectedSeconds: 25.2, times: [1.5, 6, 9.6, 12, 18, 24], width: 1920, height: 1080 },
] as const;

for (const c of CASES) {
  test(`${c.id} exports at the template's length with content in every sampled frame`, async ({ page }) => {
    test.setTimeout(300_000);
    await page.goto("/#/projects");
    await mediabunnyModuleUrl(page);
    const check = await page.evaluate(async ({ id, url, times }) => {
      const mod = (await import(/* @vite-ignore */ url)) as Browser;
      const harness = await mod.buildTemplateProject(id);
      return { warnings: harness.warnings.map((w) => w.message), exported: await mod.exportAndSample(harness, [...times]) };
    }, { id: c.id, url: BROWSER, times: c.times });

    expect(check.warnings).toEqual([]);
    expect(check.exported.width).toBe(c.width);
    expect(check.exported.height).toBe(c.height);
    expect(Math.abs(check.exported.durationSeconds - c.expectedSeconds)).toBeLessThanOrEqual(2 * FRAME_SECONDS);
    expect(Math.abs(check.exported.frames - c.expectedSeconds * 30)).toBeLessThanOrEqual(1);
    for (const sample of check.exported.samples) {
      expect(sample.nonBlack, `frame at ${sample.at}s is mostly black`).toBeGreaterThan(MIN_LIT_FRACTION);
      expect(sample.mean, `frame at ${sample.at}s is too dark`).toBeGreaterThan(14);
    }
  });
}
