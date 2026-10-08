import { expect, test, type Page } from "@playwright/test";
import { importGenerated, makeWebm } from "./media";

/** Installs image-model test doubles through the dev-only `window.__visual` hook; no model is ever downloaded. */
async function installVisualDouble(page: Page): Promise<void> {
  await page.evaluate(() => {
    const calls = { indexed: [] as string[], queries: [] as string[] };
    (window as unknown as { __visualCalls: typeof calls }).__visualCalls = calls;
    (globalThis as unknown as { __visual?: unknown }).__visual = {
      indexer: {
        async index(input: { assetId: string; onProgress?: (fraction: number) => void }) {
          calls.indexed.push(input.assetId);
          input.onProgress?.(0.4);
          await new Promise((resolve) => setTimeout(resolve, 600));
          input.onProgress?.(1);
          return {
            version: 1, assetId: input.assetId, model: "test-double", dimensions: 2, durationSeconds: 2, cuts: [],
            times: [0.5, 1.5], vectors: new Float32Array([1, 0, 0, 1]),
          };
        },
      },
      searcher: {
        model: "test-double",
        async embedText(query: string) {
          calls.queries.push(query);
          return new Float32Array([1, 0]);
        },
      },
    };
  });
}

const calls = (page: Page): Promise<{ indexed: string[]; queries: string[] }> =>
  page.evaluate(() => (window as unknown as { __visualCalls: { indexed: string[]; queries: string[] } }).__visualCalls);

async function openEditorWithVideo(page: Page, name: string): Promise<void> {
  await page.goto("/#/projects");
  await page.getByRole("button", { name: "Create your first project" }).click();
  await expect(page).toHaveURL(/#\/editor\//);
  await makeWebm(page, { seconds: 2, hue: 200, name, withAudio: false });
  await importGenerated(page);
  await installVisualDouble(page);
}

test("decodes real video frames to small RGBA bitmaps with the preview's frame decoder, without any model", async ({ page }) => {
  await page.goto("/");
  await makeWebm(page, { seconds: 3, hue: 0, name: "hues.webm" });
  const result = await page.evaluate(async () => {
    const url = "/src/platform/visual/frame-source.ts";
    const { openVideoFrames } = (await import(/* @vite-ignore */ url)) as typeof import("../src/platform/visual/frame-source");
    const file = (window as unknown as { __files: File[] }).__files[0] as File;
    const frames = openVideoFrames(file);
    const out: Array<{ t: number; width: number; height: number; length: number; r: number; g: number; b: number }> = [];
    for (const t of [0.5, 1.5, 2.5]) {
      const frame = await frames.frameAt(t);
      if (!frame) continue;
      const corner = (4 * frame.width + 4) * 4;
      out.push({ t, width: frame.width, height: frame.height, length: frame.data.length, r: frame.data[corner] ?? 0, g: frame.data[corner + 1] ?? 0, b: frame.data[corner + 2] ?? 0 });
    }
    await frames.dispose();
    return out;
  });
  expect(result).toHaveLength(3);
  for (const frame of result) {
    expect(Math.min(frame.width, frame.height)).toBeLessThanOrEqual(224);
    expect(frame.length).toBe(frame.width * frame.height * 4);
  }
  // The generated clip steps its hue 3 degrees per frame: 45 (orange) at 0.5 s, 135 (green) at 1.5 s, 225 (blue) at 2.5 s.
  const [orange, green, blue] = result;
  expect(orange?.r).toBeGreaterThan((orange?.b ?? 0) + 100);
  expect(green?.g).toBeGreaterThan((green?.r ?? 0) + 60);
  expect(green?.g).toBeGreaterThan((green?.b ?? 0) + 60);
  expect(blue?.b).toBeGreaterThan((blue?.r ?? 0) + 100);
});

test("Index visuals asks for consent before the first model download, then runs locally and saves the embeddings", async ({ page }) => {
  await openEditorWithVideo(page, "pets.webm");

  const tile = page.locator("[data-asset-id]").first();
  await expect(tile).toBeVisible();
  await tile.hover();
  await page.getByRole("button", { name: "Index visuals of pets.webm" }).click();

  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("clip-vit-base-patch32");
  await expect(dialog).toContainText("156 MB");
  await expect(dialog).toContainText("stays on this device");
  expect((await calls(page)).indexed).toEqual([]);

  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toBeHidden();
  expect((await calls(page)).indexed).toEqual([]);

  await tile.hover();
  await page.getByRole("button", { name: "Index visuals of pets.webm" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Download and index" }).click();
  await expect(page.getByRole("button", { name: "Cancel visual indexing of pets.webm" })).toContainText("%");
  await expect(page.getByText("Indexed pets.webm")).toBeVisible();
  expect((await calls(page)).indexed).toHaveLength(1);

  const saved = await page.evaluate(async () => {
    const url = "/src/platform/visual/store.ts";
    const { IdbVisualStore } = (await import(/* @vite-ignore */ url)) as typeof import("../src/platform/visual/store");
    const id = document.querySelector("[data-asset-id]")?.getAttribute("data-asset-id") ?? "";
    const embeddings = await new IdbVisualStore().get(id);
    return embeddings ? { model: embeddings.model, version: embeddings.version, vectors: Array.from(embeddings.vectors), times: embeddings.times } : null;
  });
  expect(saved).toEqual({ model: "test-double", version: 1, vectors: [1, 0, 0, 1], times: [0.5, 1.5] });

  await tile.hover();
  await page.getByRole("button", { name: "Index visuals of pets.webm" }).click();
  await expect(page.getByRole("dialog")).toBeHidden();
  await expect.poll(async () => (await calls(page)).indexed).toHaveLength(2);
});

test("cancelling an index in progress stops it without saving", async ({ page }) => {
  await openEditorWithVideo(page, "pets.webm");
  const tile = page.locator("[data-asset-id]").first();
  await tile.hover();
  await page.getByRole("button", { name: "Index visuals of pets.webm" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Download and index" }).click();
  const busy = page.getByRole("button", { name: "Cancel visual indexing of pets.webm" });
  await expect(busy).toBeVisible();
  await busy.click();
  await expect(busy).toBeHidden();
  await expect(page.getByText("Indexed pets.webm")).toHaveCount(0);
});

test("the in-app agent searches the indexed video by what it shows", async ({ page }) => {
  await openEditorWithVideo(page, "pets.webm");
  const tile = page.locator("[data-asset-id]").first();
  await tile.hover();
  await page.getByRole("button", { name: "Index visuals of pets.webm" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Download and index" }).click();
  await expect(page.getByText("Indexed pets.webm")).toBeVisible();

  await page.evaluate(async () => {
    const url = "/src/app/agent/model-client.ts";
    const { ScriptedModelClient } = (await import(/* @vite-ignore */ url)) as typeof import("../src/app/agent/model-client");
    const use = (id: string, name: string, input: unknown) => ({ type: "tool_use" as const, id, name, input });
    (globalThis as unknown as { __agentModel?: unknown }).__agentModel = new ScriptedModelClient([
      { content: [use("c1", "find_visual_moments", { allAssets: true, query: "a dog" })] },
      { content: [{ type: "text", text: "Found the dog." }] },
    ]);
  });
  await page.getByRole("tab", { name: "Agent" }).click();
  const panel = page.getByTestId("agent-panel");
  await panel.getByLabel("Message to the agent").fill("Where is the dog?");
  await panel.getByRole("button", { name: "Send" }).click();

  await expect(panel.getByTestId("agent-assistant-text").last()).toContainText("Found the dog");
  const chip = panel.getByTestId("agent-tool-chip");
  await expect(chip).toHaveCount(1);
  await expect(chip).toHaveAttribute("data-tool", "find_visual_moments");
  await expect(chip).toHaveAttribute("data-status", "ok");
  expect((await calls(page)).queries).toEqual(["a dog"]);
});
