import { expect, test } from "@playwright/test";
import fs from "node:fs";

// Opt-in: downloads the real SpeechT5 model (~105 MB) and the real opus-mt en-es model (~120 MB) from Hugging Face.
//   REAL_TTS=1 PLAYWRIGHT_PORT=5263 playwright test -c playwright.chrome.config.ts e2e/voice-real.spec.ts
// TTS_DUMP=<dir> also writes the generated 16 kHz mono samples (Float32) for an offline speech-recognition round trip.
const TEXT = "Welcome to the show. Today we are going to talk about editing video.";

test.skip(process.env.REAL_TTS !== "1", "set REAL_TTS=1 to run the real text-to-speech and translation models");

test("real SpeechT5 in a worker: consent, download, speech inserted as an audio clip", async ({ page }) => {
  test.setTimeout(1_800_000);
  const violations: string[] = [];
  page.on("console", (m) => { if (m.type() === "error") violations.push(m.text()); });
  await page.goto("/#/projects");
  await page.getByRole("button", { name: "Create your first project" }).click();
  await expect(page.getByLabel("Project name")).toBeVisible();
  await page.getByRole("tab", { name: "Text" }).click();
  await page.getByLabel("Voice-over script").fill(TEXT);
  await page.getByRole("button", { name: "Generate voice-over" }).click();
  const dialog = page.getByRole("dialog", { name: "Download the voice model?" });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("105 MB");
  const started = Date.now();
  await dialog.getByRole("button", { name: "Download and generate" }).click();
  await expect(page.getByTestId("tts-status")).toBeVisible();
  await expect(page.getByText("Voice-over added")).toBeVisible({ timeout: 1_700_000 });
  console.info(`tts: end to end in ${((Date.now() - started) / 1000).toFixed(0)} s (includes the model download)`);

  const info = await page.evaluate(async () => {
    const { getServices } = (await import(/* @vite-ignore */ ("/src/app/services.ts" as string))) as typeof import("../src/app/services");
    const { currentScene } = (await import(/* @vite-ignore */ ("/src/engine/commands/index.ts" as string))) as typeof import("../src/engine/commands");
    const { editor, runtime } = getServices();
    const clip = currentScene(editor.getState().doc).tracks.audio[0]?.elements[0];
    if (!clip || clip.type !== "audio") return null;
    const blob = runtime.getBlob(clip.mediaId) as Blob;
    const ctx = new AudioContext();
    const decoded = await ctx.decodeAudioData(await blob.arrayBuffer());
    const samples = Array.from(decoded.getChannelData(0));
    return { seconds: decoded.duration, rate: decoded.sampleRate, samples, start: clip.startTime, duration: clip.duration, name: clip.name };
  });
  expect(info).not.toBeNull();
  const samples = Float32Array.from(info?.samples ?? []);
  const rms = Math.sqrt(samples.reduce((s, v) => s + v * v, 0) / Math.max(1, samples.length));
  console.info(`tts: ${info?.seconds.toFixed(2)} s @ ${info?.rate} Hz, rms ${rms.toFixed(3)}, clip "${info?.name}"`);
  expect(info?.seconds ?? 0).toBeGreaterThan(3);
  expect(rms).toBeGreaterThan(0.01);
  if (process.env.TTS_DUMP) fs.writeFileSync(`${process.env.TTS_DUMP}/browser-tts.f32`, Buffer.from(samples.buffer));
  console.info(`page errors: ${violations.filter((v) => !/Mediabunny was loaded twice/.test(v)).join(" | ") || "none"}`);
});

test("real opus-mt en->es in a worker: consent, download, a translated caption track", async ({ page }) => {
  test.setTimeout(1_800_000);
  await page.goto("/#/projects");
  await page.getByRole("button", { name: "Create your first project" }).click();
  await expect(page.getByLabel("Project name")).toBeVisible();
  await page.evaluate(async () => {
    const { getServices } = (await import(/* @vite-ignore */ ("/src/app/services.ts" as string))) as typeof import("../src/app/services");
    const { insertElementsOnLanes } = (await import(/* @vite-ignore */ ("/src/engine/commands/index.ts" as string))) as typeof import("../src/engine/commands");
    const { captionElement } = (await import(/* @vite-ignore */ ("/src/engine/agent/captions.ts" as string))) as typeof import("../src/engine/agent/captions");
    const { editor } = getServices();
    const lines = ["Welcome to the show.", "Today we are going to talk about editing video.", "Press the red button to start recording, then trim the clip."];
    const canvas = editor.getState().doc.settings.canvasSize;
    const elements = lines.map((text, i) => captionElement({ cue: { text, startTime: (i * 3 * 120_000) as never, duration: (3 * 120_000) as never }, index: i, id: editor.newId(), canvas, startTime: (i * 3 * 120_000) as never, duration: (3 * 120_000) as never }));
    editor.execute(insertElementsOnLanes({ elements, index: 0, label: "Captions" }));
  });
  await page.getByRole("tab", { name: "Captions" }).click();
  await page.getByRole("button", { name: "Translate", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Download the translation model?" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Download and translate" }).click();
  await expect(page.getByText(/Translated 3 captions/)).toBeVisible({ timeout: 1_700_000 });
  const texts = await page.evaluate(async () => {
    const { getServices } = (await import(/* @vite-ignore */ ("/src/app/services.ts" as string))) as typeof import("../src/app/services");
    const { currentScene } = (await import(/* @vite-ignore */ ("/src/engine/commands/index.ts" as string))) as typeof import("../src/engine/commands");
    return currentScene(getServices().editor.getState().doc).tracks.overlay.flatMap((t) => t.elements.filter((e) => e.name?.includes("(Spanish)")).map((e) => String(e.params.content).replace(/\n/g, " ")));
  });
  console.info(`translate: ${JSON.stringify(texts)}`);
  expect(texts).toHaveLength(3);
  expect(texts.join(" ")).toMatch(/Bienvenid/i);
});
