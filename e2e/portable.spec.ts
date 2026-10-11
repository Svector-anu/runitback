import { expect, test, type Page } from "@playwright/test";
import { importGenerated, makeWebm } from "./media";

const DERIVED_DBS = [
  { db: "runitback-analysis", store: "analysis" },
  { db: "runitback-transcripts", store: "transcripts" },
  { db: "runitback-visual", store: "embeddings" },
  { db: "runitback-faces", store: "detections" },
] as const;

const CLIP_MODEL = "Xenova/clip-vit-base-patch32";
const FACE_MODEL = "mediapipe/blaze_face_short_range";

async function installDoubles(page: Page): Promise<void> {
  await page.evaluate(({ clip, face }) => {
    const g = globalThis as unknown as Record<string, unknown>;
    g["__transcriber"] = {
      async transcribe(input: { assetId: string }) {
        return { version: 1, assetId: input.assetId, language: "en", model: "test-double", words: [{ text: "hello", startSeconds: 0.2, endSeconds: 0.6 }] };
      },
    };
    g["__visual"] = {
      indexer: { async index(input: { assetId: string }) { return { version: 1, assetId: input.assetId, model: clip, dimensions: 2, durationSeconds: 2, cuts: [], times: [0.5, 1.5], vectors: new Float32Array([1, 0, 0, 1]) }; } },
      searcher: { model: clip, async embedText() { return new Float32Array([1, 0]); } },
    };
    g["__faces"] = {
      indexer: { async index(input: { assetId: string }) { return { version: 1, assetId: input.assetId, model: face, durationSeconds: 2, frames: [{ t: 0.5, boxes: [] }] }; } },
    };
  }, { clip: CLIP_MODEL, face: FACE_MODEL });
}

/** Rows per derived database; a database that does not exist yet counts as empty. */
async function derivedRows(page: Page): Promise<Record<string, number>> {
  return page.evaluate(async (specs) => {
    const out: Record<string, number> = {};
    for (const { db, store } of specs) {
      const names = (await indexedDB.databases()).map((d) => d.name);
      if (!names.includes(db)) { out[db] = 0; continue; }
      out[db] = await new Promise<number>((resolve, reject) => {
        const open = indexedDB.open(db);
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const conn = open.result;
          const req = conn.transaction(store, "readonly").objectStore(store).count();
          req.onsuccess = () => { conn.close(); resolve(req.result); };
          req.onerror = () => reject(req.error);
        };
      });
    }
    return out;
  }, DERIVED_DBS);
}

async function understoodProject(page: Page, name: string): Promise<void> {
  await page.goto("/#/projects");
  await page.getByRole("button", { name: /New project|Create your first project/ }).first().click();
  await expect(page).toHaveURL(/#\/editor\//);
  await makeWebm(page, { seconds: 2, hue: 120, name, withAudio: true });
  await importGenerated(page);
  await installDoubles(page);
  const tile = page.locator("[data-asset-id]").first();
  await expect(tile).toBeVisible({ timeout: 30_000 });
  await tile.hover();
  await page.getByRole("button", { name: `Understand ${name}` }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Download and understand" }).click();
  await expect(tile.locator(".media-item__status")).toHaveAttribute("data-state", "understood", { timeout: 30_000 });
}

async function backToProjects(page: Page): Promise<void> {
  await page.goto("/#/projects");
  await expect(page.getByRole("group", { name: /^Project / }).first()).toBeVisible();
}

const previewPixel = (page: Page): Promise<number[]> => page.evaluate(() => {
  const c = document.querySelector<HTMLCanvasElement>(".preview__scene canvas");
  if (!c) throw new Error("no canvas");
  const ctx = c.getContext("2d") as CanvasRenderingContext2D;
  return Array.from(ctx.getImageData(10, 10, 1, 1).data.slice(0, 3));
});

test("deleting a project removes its derived data from every database", async ({ page }) => {
  await understoodProject(page, "talk.webm");
  await backToProjects(page);
  const before = await derivedRows(page);
  expect(before["runitback-transcripts"]).toBe(1);
  expect(before["runitback-visual"]).toBe(1);
  expect(before["runitback-faces"]).toBe(1);
  expect(before["runitback-analysis"]).toBeGreaterThanOrEqual(1);

  await page.getByRole("button", { name: /^Actions for / }).first().click({ force: true });
  await page.getByRole("menuitem", { name: "Delete" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Delete project" }).click();
  await expect(page.getByText("No projects yet")).toBeVisible();
  await expect.poll(() => derivedRows(page)).toEqual({ "runitback-analysis": 0, "runitback-transcripts": 0, "runitback-visual": 0, "runitback-faces": 0 });
});

test("export, delete, import: clips, media and derived transcript come back in a new project", async ({ page }, testInfo) => {
  await understoodProject(page, "round.webm");
  await page.getByRole("button", { name: "Add round.webm to timeline" }).click({ force: true });
  await expect(page.locator("[data-clip-id]")).toHaveCount(1);
  await expect.poll(() => previewPixel(page)).not.toEqual([0, 0, 0]);
  await backToProjects(page);

  await page.getByRole("button", { name: /^Actions for / }).first().click({ force: true });
  await page.getByRole("menuitem", { name: "Export project" }).click();
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("dialog").getByRole("button", { name: "Export" }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/\.runitback$/);
  const bundlePath = testInfo.outputPath("bundle.runitback");
  await download.saveAs(bundlePath);
  await expect(page.getByText(/Exported /)).toBeVisible();

  await page.getByRole("button", { name: /^Actions for / }).first().click({ force: true });
  await page.getByRole("menuitem", { name: "Delete" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Delete project" }).click();
  await expect(page.getByText("No projects yet")).toBeVisible();
  expect((await derivedRows(page))["runitback-transcripts"]).toBe(0);

  await page.getByLabel("Import project file").setInputFiles(bundlePath);
  await expect(page.getByText(/Imported /)).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("group", { name: /^Project / })).toHaveCount(1);
  const after = await derivedRows(page);
  expect(after["runitback-transcripts"]).toBe(1);
  expect(after["runitback-faces"]).toBe(1);
  expect(after["runitback-visual"]).toBe(1);

  await page.getByRole("button", { name: /^New project|Project / }).first().isVisible();
  await page.getByRole("group", { name: /^Project / }).locator(".project-card__open").click();
  await expect(page).toHaveURL(/#\/editor\//);
  await expect(page.locator("[data-clip-id]")).toHaveCount(1, { timeout: 30_000 });
  await expect.poll(() => previewPixel(page), { timeout: 30_000 }).not.toEqual([0, 0, 0]);
  const tile = page.locator("[data-asset-id]").first();
  await tile.hover();
  await page.getByRole("button", { name: "Understand round.webm" }).click();
  await expect(page.getByText("Already understood")).toBeVisible();
});

test("a damaged file is rejected with a message and creates nothing", async ({ page }, testInfo) => {
  await page.goto("/#/projects");
  const bad = testInfo.outputPath("bad.runitback");
  const { writeFileSync } = await import("node:fs");
  writeFileSync(bad, "this is not a bundle");
  await page.getByLabel("Import project file").setInputFiles(bad);
  await expect(page.getByText("Could not import the project")).toBeVisible();
  await expect(page.getByText("No projects yet")).toBeVisible();
});
