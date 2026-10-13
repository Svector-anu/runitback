import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import { importWav } from "./audio-support";
import { importGenerated, makeWebm } from "./media";
import { speechPlusNoise } from "../tests/speech-fixture";

const fixture = speechPlusNoise({ sampleRate: 48_000, seconds: 6 });

async function setup(page: Page): Promise<void> {
  await page.goto("/#/projects");
  await page.getByRole("button", { name: "Create your first project" }).click();
  await expect(page.getByLabel("Project name")).toBeVisible();
  await makeWebm(page, { seconds: 6, hue: 200, name: "footage.webm" });
  await importGenerated(page);
  await importWav(page, { name: "speech.wav", samples: fixture.mixed, sampleRate: fixture.sampleRate });
  await page.getByRole("button", { name: "Add footage.webm to timeline" }).click({ force: true });
  await page.getByRole("button", { name: "Add speech.wav to timeline" }).click({ force: true });
  await expect(page.locator("[data-clip-id]")).toHaveCount(2);
}

/** Exports the project as WebM through the app and measures the exported audio in the pauses and in the voiced parts. */
async function exportAndMeasure(page: Page): Promise<{ pauseDb: number; voicedDb: number }> {
  await page.getByRole("button", { name: "Export", exact: true }).first().click();
  const webm = page.getByLabel("WebM (VP9)");
  if (!(await webm.isVisible())) await page.getByRole("button", { name: "Format" }).click();
  await webm.check();
  const downloadPromise = page.waitForEvent("download", { timeout: 180_000 });
  await page.getByRole("dialog", { name: "Export project" }).getByRole("button", { name: "Export" }).click();
  const download = await downloadPromise;
  const bytes = fs.readFileSync(await download.path());
  return page.evaluate(async ({ data, pauses, voiced }) => {
    const url = "/node_modules/.vite/deps/mediabunny.js";
    const { Input, BlobSource, ALL_FORMATS, AudioBufferSink } = (await import(/* @vite-ignore */ url)) as typeof import("mediabunny");
    const input = new Input({ source: new BlobSource(new Blob([new Uint8Array(data)], { type: "video/webm" })), formats: ALL_FORMATS });
    const track = await input.getPrimaryAudioTrack();
    if (!track) throw new Error("the export has no audio track");
    const sink = new AudioBufferSink(track);
    const chunks: Array<{ at: number; samples: Float32Array }> = [];
    let rate = 0;
    for await (const wrapped of sink.buffers()) {
      rate = wrapped.buffer.sampleRate;
      const mono = new Float32Array(wrapped.buffer.length);
      for (let c = 0; c < wrapped.buffer.numberOfChannels; c++) {
        const channel = wrapped.buffer.getChannelData(c);
        for (let i = 0; i < mono.length; i++) mono[i] = (mono[i] as number) + (channel[i] as number) / wrapped.buffer.numberOfChannels;
      }
      chunks.push({ at: Math.round(wrapped.timestamp * rate), samples: mono });
    }
    const level = (spans: Array<[number, number]>): number => {
      let sum = 0;
      let count = 0;
      for (const [from, to] of spans) {
        for (const chunk of chunks) {
          const a = Math.max(Math.round(from * rate), chunk.at);
          const b = Math.min(Math.round(to * rate), chunk.at + chunk.samples.length);
          for (let i = a; i < b; i++) {
            sum += (chunk.samples[i - chunk.at] as number) ** 2;
            count++;
          }
        }
      }
      return 10 * Math.log10(Math.max(sum / Math.max(1, count), 1e-20));
    };
    return { pauseDb: level(pauses), voicedDb: level(voiced) };
  }, { data: [...bytes], pauses: fixture.pauses, voiced: fixture.voiced });
}

test("Noise removal: slider, cached progress, and the exported audio has a measurably lower noise floor", async ({ page }) => {
  test.setTimeout(480_000);
  await setup(page);
  const baseline = await exportAndMeasure(page);

  const audioClip = page.locator('[data-clip-id]').filter({ hasText: "speech.wav" }).first();
  await audioClip.click();
  await page.getByRole("tab", { name: "Audio" }).click();
  const slider = page.getByRole("slider", { name: "Noise removal" });
  await expect(slider).toBeVisible();
  await slider.fill("1");
  const note = page.getByTestId("denoise-note");
  await expect(note).toHaveAttribute("data-state", /running|ready/, { timeout: 30_000 });
  await expect.poll(async () => (await note.getAttribute("data-state")) === "error" ? `error: ${await note.textContent()}` : await note.getAttribute("data-state"), { timeout: 120_000 }).toBe("ready");
  const reported = (await note.textContent()) ?? "";
  console.info(`denoise note: ${reported}`);
  expect(reported).toMatch(/Noise floor -?\d+ dB to -?\d+ dB/);

  const cleaned = await exportAndMeasure(page);
  const reduction = baseline.pauseDb - cleaned.pauseDb;
  console.info(`denoise export: pause floor ${baseline.pauseDb.toFixed(1)} dB -> ${cleaned.pauseDb.toFixed(1)} dB (${reduction.toFixed(1)} dB lower); speech ${baseline.voicedDb.toFixed(1)} -> ${cleaned.voicedDb.toFixed(1)} dB`);
  expect(reduction).toBeGreaterThan(15);
  expect(Math.abs(cleaned.voicedDb - baseline.voicedDb)).toBeLessThan(2.5);

  await slider.fill("0");
  await expect(page.getByText(/Removes steady background noise/)).toBeVisible();
});
