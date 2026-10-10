import { expect, test, type Page } from "@playwright/test";
import { importGenerated, makeWebm } from "./media";

const CLIP_MODEL = "Xenova/clip-vit-base-patch32";
const FACE_MODEL = "mediapipe/blaze_face_short_range";

interface Calls { transcribed: string[]; indexed: string[]; faces: string[] }

/** Installs speech, image-model and face-detector test doubles through the dev-only hooks; no model is ever downloaded. */
async function installDoubles(page: Page): Promise<void> {
  await page.evaluate(({ clip, face }) => {
    const calls: Calls = { transcribed: [], indexed: [], faces: [] };
    const host = window as unknown as { __understandCalls: Calls };
    host.__understandCalls = calls;
    const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
    const g = globalThis as unknown as Record<string, unknown>;
    g["__transcriber"] = {
      async transcribe(input: { assetId: string; onProgress?: (f: number) => void }) {
        calls.transcribed.push(input.assetId);
        input.onProgress?.(0.5);
        await pause(500);
        return { version: 1, assetId: input.assetId, language: "en", model: "test-double", words: [{ text: "hello", startSeconds: 0.2, endSeconds: 0.6 }] };
      },
    };
    g["__visual"] = {
      indexer: {
        async index(input: { assetId: string; onProgress?: (f: number) => void }) {
          calls.indexed.push(input.assetId);
          input.onProgress?.(0.5);
          await pause(500);
          return { version: 1, assetId: input.assetId, model: clip, dimensions: 2, durationSeconds: 2, cuts: [], times: [0.5, 1.5], vectors: new Float32Array([1, 0, 0, 1]) };
        },
      },
      searcher: { model: clip, async embedText() { return new Float32Array([1, 0]); } },
    };
    g["__faces"] = {
      indexer: {
        async index(input: { assetId: string; onProgress?: (f: number) => void }) {
          calls.faces.push(input.assetId);
          input.onProgress?.(0.5);
          await pause(500);
          return { version: 1, assetId: input.assetId, model: face, durationSeconds: 2, frames: [{ t: 0.5, boxes: [] }, { t: 1.5, boxes: [{ x: 0.1, y: 0.1, width: 0.2, height: 0.2, score: 0.9 }] }] };
        },
      },
    };
  }, { clip: CLIP_MODEL, face: FACE_MODEL });
}

const calls = (page: Page): Promise<Calls> => page.evaluate(() => (window as unknown as { __understandCalls: Calls }).__understandCalls);

test("Understand footage asks for one combined consent, shows progress, then marks the asset understood", async ({ page }) => {
  await page.goto("/#/projects");
  await page.getByRole("button", { name: "Create your first project" }).click();
  await expect(page).toHaveURL(/#\/editor\//);
  await makeWebm(page, { seconds: 2, hue: 200, name: "talk.webm", withAudio: true });
  await importGenerated(page);
  await installDoubles(page);

  const tile = page.locator("[data-asset-id]").first();
  await expect(tile).toBeVisible();
  await tile.hover();
  await page.getByRole("button", { name: "Understand talk.webm" }).click();

  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("whisper-tiny.en");
  await expect(dialog).toContainText("clip-vit-base-patch32");
  await expect(dialog).toContainText("stays on this device");
  expect(await calls(page)).toEqual({ transcribed: [], indexed: [], faces: [] });

  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toBeHidden();
  expect(await calls(page)).toEqual({ transcribed: [], indexed: [], faces: [] });

  await tile.hover();
  await page.getByRole("button", { name: "Understand talk.webm" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Download and understand" }).click();

  const chip = tile.locator(".media-item__status");
  await expect(chip).toHaveAttribute("data-state", "running");
  await expect(chip).toContainText("%");
  await expect(page.getByRole("button", { name: "Cancel understanding of talk.webm" })).toBeVisible();

  await expect(chip).toHaveAttribute("data-state", "understood", { timeout: 20_000 });
  await expect(chip).toHaveText("Understood");
  await expect(page.getByText("Understood talk.webm")).toBeVisible();
  const done = await calls(page);
  expect(done.transcribed).toHaveLength(1);
  expect(done.indexed).toHaveLength(1);
  expect(done.faces).toHaveLength(1);

  await tile.hover();
  await page.getByRole("button", { name: "Understand talk.webm" }).click();
  await expect(page.getByRole("dialog")).toBeHidden();
  await expect(page.getByText("Already understood")).toBeVisible();
  expect(await calls(page)).toEqual(done);
});

test("a failing stage leaves the asset partial and the other stages still run; running again resumes only that stage", async ({ page }) => {
  await page.goto("/#/projects");
  await page.getByRole("button", { name: "Create your first project" }).click();
  await expect(page).toHaveURL(/#\/editor\//);
  await makeWebm(page, { seconds: 2, hue: 80, name: "clip.webm", withAudio: true });
  await importGenerated(page);
  await installDoubles(page);
  await page.evaluate(() => {
    const g = globalThis as unknown as { __faces: { indexer: { index: () => Promise<never> } } };
    const original = g.__faces.indexer.index;
    (window as unknown as { __restoreFaces: () => void }).__restoreFaces = () => { g.__faces.indexer.index = original; };
    g.__faces.indexer.index = () => Promise.reject(new Error("detector offline"));
  });

  const tile = page.locator("[data-asset-id]").first();
  await tile.hover();
  await page.getByRole("button", { name: "Understand clip.webm" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Download and understand" }).click();

  const chip = tile.locator(".media-item__status");
  await expect(chip).toHaveAttribute("data-state", "partial", { timeout: 20_000 });
  await expect(chip).toHaveAttribute("title", /faces failed/);
  await expect(page.getByText("clip.webm is only partly understood")).toBeVisible();
  const first = await calls(page);
  expect(first.transcribed).toHaveLength(1);
  expect(first.indexed).toHaveLength(1);

  await page.evaluate(() => (window as unknown as { __restoreFaces: () => void }).__restoreFaces());
  await tile.hover();
  await page.getByRole("button", { name: "Understand clip.webm" }).click();
  await expect(chip).toHaveAttribute("data-state", "understood", { timeout: 20_000 });
  const resumed = await calls(page);
  expect(resumed.transcribed).toHaveLength(1);
  expect(resumed.indexed).toHaveLength(1);
  expect(resumed.faces).toHaveLength(1);
});
