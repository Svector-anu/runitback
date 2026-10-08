import { expect, test, type Page } from "@playwright/test";
import { importGenerated, makeWebm } from "./media";

/** Installs a transcriber test double through the dev-only `window.__transcriber` hook; no model is ever downloaded. */
async function installTranscriberDouble(page: Page): Promise<void> {
  await page.evaluate(() => {
    const calls: string[] = [];
    (window as unknown as { __transcribeCalls: string[] }).__transcribeCalls = calls;
    (globalThis as unknown as { __transcriber?: unknown }).__transcriber = {
      async transcribe(input: { assetId: string; onProgress?: (fraction: number) => void }) {
        calls.push(input.assetId);
        input.onProgress?.(0.4);
        await new Promise((resolve) => setTimeout(resolve, 600));
        input.onProgress?.(1);
        return {
          version: 1, assetId: input.assetId, language: "en", model: "test-double",
          words: [{ text: "hello", startSeconds: 0.2, endSeconds: 0.6 }, { text: "world", startSeconds: 0.7, endSeconds: 1.1 }],
        };
      },
    };
  });
}

const calls = (page: Page): Promise<string[]> => page.evaluate(() => (window as unknown as { __transcribeCalls: string[] }).__transcribeCalls);

test("decodes real media to 16 kHz mono speech audio without any model", async ({ page }) => {
  await page.goto("/");
  await makeWebm(page, { seconds: 3, hue: 120, name: "tone.webm", withAudio: true });
  const result = await page.evaluate(async () => {
    const url = "/src/platform/transcribe/audio-source.ts";
    const { openAudio16k } = (await import(/* @vite-ignore */ url)) as typeof import("../src/platform/transcribe/audio-source");
    const file = (window as unknown as { __files: File[] }).__files[0] as File;
    const source = await openAudio16k(file);
    if (!source) return null;
    let samples = 0;
    let energy = 0;
    for await (const block of source.blocks()) {
      samples += block.length;
      for (const v of block) energy += v * v;
    }
    source.dispose();
    return { samples, rms: Math.sqrt(energy / samples), duration: source.durationSeconds };
  });
  expect(result).not.toBeNull();
  expect(Math.abs((result?.samples ?? 0) - 3 * 16_000)).toBeLessThan(16_000 * 0.2);
  expect(result?.rms ?? 0).toBeGreaterThan(0.15);
  expect(result?.rms ?? 1).toBeLessThan(0.3);
});

test("Transcribe asks for consent before the first model download, then runs locally and saves the transcript", async ({ page }) => {
  await page.goto("/#/projects");
  await page.getByRole("button", { name: "Create your first project" }).click();
  await expect(page).toHaveURL(/#\/editor\//);
  await makeWebm(page, { seconds: 2, hue: 200, name: "speech.webm", withAudio: true });
  await importGenerated(page);
  await installTranscriberDouble(page);

  const tile = page.locator('[data-asset-id]').first();
  await expect(tile).toBeVisible();
  await tile.hover();
  await page.getByRole("button", { name: "Transcribe speech.webm" }).click();

  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("whisper-tiny.en");
  await expect(dialog).toContainText("50 MB");
  await expect(dialog).toContainText("stays on this device");
  expect(await calls(page)).toEqual([]);

  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toBeHidden();
  expect(await calls(page)).toEqual([]);

  await tile.hover();
  await page.getByRole("button", { name: "Transcribe speech.webm" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Download and transcribe" }).click();
  await expect(page.getByRole("button", { name: "Cancel transcription of speech.webm" })).toContainText("%");
  await expect(page.getByText("Transcribed speech.webm")).toBeVisible();
  expect(await calls(page)).toHaveLength(1);

  const saved = await page.evaluate(async () => {
    const url = "/src/platform/transcribe/store.ts";
    const { IdbTranscriptStore } = (await import(/* @vite-ignore */ url)) as typeof import("../src/platform/transcribe/store");
    const id = document.querySelector("[data-asset-id]")?.getAttribute("data-asset-id") ?? "";
    return (await new IdbTranscriptStore().get(id))?.words.map((w) => w.text);
  });
  expect(saved).toEqual(["hello", "world"]);

  await tile.hover();
  await page.getByRole("button", { name: "Transcribe speech.webm" }).click();
  await expect(page.getByRole("dialog")).toBeHidden();
  await expect.poll(() => calls(page)).toHaveLength(2);
});
