import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import { importGenerated, makeWebm, mediabunnyModuleUrl } from "./media";
import { recordMeasurement, sampleHeap } from "./perf-support";

const CLIP_SECONDS = 20;
const CLIPS = 6;

async function sequenceClips(page: Page): Promise<void> {
  await page.evaluate(async ({ count, clipTicks }) => {
    const servicesUrl = "/src/app/services.ts";
    const commandsUrl = "/src/engine/commands/index.ts";
    const { getServices } = (await import(servicesUrl)) as typeof import("../src/app/services");
    const { insertMediaElement } = (await import(commandsUrl)) as typeof import("../src/engine/commands");
    const { editor } = getServices();
    const asset = editor.getState().doc.assets[0];
    if (!asset) throw new Error("no asset imported");
    for (let i = 0; i < count; i++) {
      editor.execute(insertMediaElement({ asset, elementId: editor.newId(), startTime: i * clipTicks, placement: { mode: "auto" } }));
    }
    if (editor.duration() < count * clipTicks) throw new Error("clips were not placed sequentially");
  }, { count: CLIPS, clipTicks: CLIP_SECONDS * 120_000 });
}

test("a 2-minute project exports with chunked audio, bounded heap and a seamless mix", async ({ page }) => {
  test.setTimeout(420_000);
  await page.goto("/#/projects");
  await page.getByRole("button", { name: "Create your first project" }).click();
  await makeWebm(page, { seconds: CLIP_SECONDS, hue: 120, name: "long.webm", withAudio: true });
  await importGenerated(page);
  await expect(page.getByRole("button", { name: "Add long.webm to timeline" })).toBeVisible();
  await sequenceClips(page);

  await page.getByRole("button", { name: "Export", exact: true }).first().click();
  await page.getByRole("button", { name: "Format" }).click();
  await page.getByLabel("WebM (VP9)").check();
  const downloadPromise = page.waitForEvent("download", { timeout: 400_000 });
  const stopHeap = await sampleHeap(page);
  const startedAt = Date.now();
  await page.getByRole("dialog", { name: "Export project" }).getByRole("button", { name: "Export" }).click();
  const download = await downloadPromise;
  const exportSeconds = (Date.now() - startedAt) / 1000;
  const heap = await stopHeap();
  const bytes = fs.readFileSync((await download.path())!);

  const url = await mediabunnyModuleUrl(page);
  const audio = await page.evaluate(async ({ data, moduleUrl, endSeconds, tailSeconds }) => {
    const { Input, BlobSource, ALL_FORMATS, AudioBufferSink } = (await import(moduleUrl)) as typeof import("mediabunny");
    const input = new Input({ source: new BlobSource(new Blob([new Uint8Array(data)], { type: "video/webm" })), formats: ALL_FORMATS });
    const track = await input.getPrimaryAudioTrack();
    if (!track) return null;
    const sink = new AudioBufferSink(track);
    let seconds = 0;
    let maxStep = 0;
    let previous: number | null = null;
    for await (const wrapped of sink.buffers()) {
      const channel = wrapped.buffer.getChannelData(0);
      for (let i = 0; i < channel.length; i++) {
        const sample = channel[i] as number;
        if (previous !== null) {
          const atSeconds = wrapped.timestamp + i / wrapped.buffer.sampleRate;
          if (atSeconds < endSeconds - tailSeconds) maxStep = Math.max(maxStep, Math.abs(sample - previous));
        }
        previous = sample;
      }
      seconds += wrapped.duration;
    }
    return { seconds, maxStep, duration: await input.computeDuration() };
  }, { data: [...bytes], moduleUrl: url, endSeconds: CLIP_SECONDS * CLIPS, tailSeconds: 0.05 });

  expect(audio).not.toBeNull();
  recordMeasurement("perf-export", {
    projectSeconds: CLIP_SECONDS * CLIPS, exportSeconds, fileMb: Math.round(bytes.length / 1e5) / 10,
    peakJsHeapMb: heap.peakMb, heapSamples: heap.samples, audioSeconds: Math.round((audio?.seconds ?? 0) * 100) / 100,
    maxSampleStep: Math.round((audio?.maxStep ?? 0) * 1000) / 1000,
  });
  expect(audio!.seconds).toBeGreaterThan(CLIP_SECONDS * CLIPS - 1);
  expect(audio!.seconds).toBeLessThan(CLIP_SECONDS * CLIPS + 1);
  // A 440 Hz tone at 0.3 amplitude changes by < 0.06 per sample; a click at a chunk seam would exceed this. The encoder's final padding sample is excluded.
  expect(audio!.maxStep).toBeLessThan(0.15);
  expect(heap.peakMb).toBeLessThan(600);
});
