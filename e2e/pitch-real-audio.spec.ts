import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import { importGenerated, makeWebm } from "./media";

const TONE_HZ = 440;
const PITCH_TOLERANCE = 0.02;

async function exportSpedUpClip(page: Page, input: { maintainPitch: boolean }): Promise<Buffer> {
  await page.goto("/#/projects");
  await page.getByRole("button", { name: "Create your first project" }).click();
  await makeWebm(page, { seconds: 4, hue: 10, name: "tone.webm", withAudio: true });
  await importGenerated(page);
  await page.getByRole("button", { name: "Add tone.webm to timeline" }).click({ force: true });
  const clip = page.locator("[data-clip-id]");
  await expect(clip).toHaveCount(1);
  await clip.first().click();
  await page.getByRole("tab", { name: "Speed" }).click();

  const speed = page.getByRole("textbox", { name: "Speed" });
  await speed.fill("2");
  await speed.press("Enter");
  await expect.poll(() => clip.first().getAttribute("data-duration")).toBe(String(2 * 120000));

  const changePitch = page.getByRole("switch", { name: "Change pitch" });
  await expect(changePitch).toBeEnabled();
  await expect(changePitch).toHaveAttribute("aria-checked", "true");
  if (input.maintainPitch) {
    await changePitch.click();
    await expect(changePitch).toHaveAttribute("aria-checked", "false");
  }

  await page.getByRole("button", { name: "Export", exact: true }).first().click();
  await page.getByRole("button", { name: "Format" }).click();
  await page.getByLabel("WebM (VP9)").check();
  const downloadPromise = page.waitForEvent("download", { timeout: 90_000 });
  await page.getByRole("dialog", { name: "Export project" }).getByRole("button", { name: "Export" }).click();
  const download = await downloadPromise;
  return fs.readFileSync(await download.path());
}

/** Decodes the exported file with the browser's decoder and autocorrelates a mid-clip window. */
async function measureExportedPitch(page: Page, bytes: Buffer): Promise<{ hz: number; seconds: number; rms: number }> {
  return page.evaluate(async (data) => {
    const ac = new AudioContext();
    const decoded = await ac.decodeAudioData(new Uint8Array(data).buffer);
    const samples = decoded.getChannelData(0);
    const rate = decoded.sampleRate;
    const start = Math.floor(rate * 0.5);
    const size = Math.floor(rate * 0.5);
    const window = samples.subarray(start, start + size);
    let energy = 0;
    for (let i = 0; i < window.length; i++) energy += (window[i] ?? 0) ** 2;
    const rms = Math.sqrt(energy / window.length);
    const minLag = Math.floor(rate / 2000);
    const maxLag = Math.floor(rate / 100);
    const correlation = (lag: number): number => {
      let sum = 0;
      for (let i = 0; i + lag < window.length; i++) sum += (window[i] ?? 0) * (window[i + lag] ?? 0);
      return sum;
    };
    const values: number[] = [];
    for (let lag = minLag; lag <= maxLag; lag++) values.push(correlation(lag));
    const peak = Math.max(...values);
    // First local maximum reaching 90% of the global peak avoids octave errors on harmonics.
    let best = minLag;
    for (let i = 1; i < values.length - 1; i++) {
      const v = values[i] ?? 0;
      if (v >= peak * 0.9 && v >= (values[i - 1] ?? 0) && v >= (values[i + 1] ?? 0)) { best = minLag + i; break; }
    }
    const y0 = values[best - minLag - 1] ?? 0;
    const y1 = values[best - minLag] ?? 0;
    const y2 = values[best - minLag + 1] ?? 0;
    const denom = y0 - 2 * y1 + y2;
    const offset = denom === 0 ? 0 : (0.5 * (y0 - y2)) / denom;
    await ac.close();
    return { hz: rate / (best + offset), seconds: decoded.duration, rms };
  }, [...bytes]);
}

test("export at 2x with Change pitch off (maintainPitch) keeps a 440 Hz tone at ~440 Hz", async ({ page }) => {
  const bytes = await exportSpedUpClip(page, { maintainPitch: true });
  const result = await measureExportedPitch(page, bytes);
  console.log(`maintainPitch=true measured ${result.hz.toFixed(2)} Hz, ${result.seconds.toFixed(2)} s, rms ${result.rms.toFixed(3)}`);
  expect(result.rms).toBeGreaterThan(0.05);
  expect(result.seconds).toBeGreaterThan(1.8);
  expect(result.seconds).toBeLessThan(2.3);
  expect(Math.abs(result.hz - TONE_HZ) / TONE_HZ).toBeLessThan(PITCH_TOLERANCE);
});

test("export at 2x with Change pitch on (default) shifts a 440 Hz tone to ~880 Hz", async ({ page }) => {
  const bytes = await exportSpedUpClip(page, { maintainPitch: false });
  const result = await measureExportedPitch(page, bytes);
  console.log(`maintainPitch=false measured ${result.hz.toFixed(2)} Hz, ${result.seconds.toFixed(2)} s, rms ${result.rms.toFixed(3)}`);
  expect(result.rms).toBeGreaterThan(0.05);
  expect(Math.abs(result.hz - TONE_HZ * 2) / (TONE_HZ * 2)).toBeLessThan(PITCH_TOLERANCE);
});
