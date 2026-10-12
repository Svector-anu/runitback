import { expect, test } from "@playwright/test";
import { importGenerated, makeWebm } from "./media";

async function projectWithAsset(page: import("@playwright/test").Page): Promise<void> {
  await page.goto("/#/projects");
  await page.getByRole("button", { name: "Create your first project" }).click();
  await makeWebm(page, { seconds: 2, hue: 40, name: "qa-a.webm", withAudio: false });
  await importGenerated(page);
  await page.getByRole("button", { name: "Add qa-a.webm to timeline" }).waitFor({ state: "attached" });
}

test("QA-P1-1: Enter on the focused 'Add to timeline' button adds exactly one clip", async ({ page }) => {
  await projectWithAsset(page);
  await page.getByRole("button", { name: "Add qa-a.webm to timeline" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("[data-clip-id]")).toHaveCount(1);
});

test("QA-P1-1b: Enter on 'Transcribe' does not also add the clip to the timeline", async ({ page }) => {
  await projectWithAsset(page);
  await page.getByRole("button", { name: "Transcribe qa-a.webm" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("[data-clip-id]")).toHaveCount(0);
});

test("QA-P1-1c: Enter and Space on the media card itself still add and select", async ({ page }) => {
  await projectWithAsset(page);
  const card = page.getByRole("group", { name: "video qa-a.webm" });
  await card.focus();
  await page.keyboard.press("Space");
  await expect(card).toHaveAttribute("data-selected", "true");
  await page.keyboard.press("Enter");
  await expect(page.locator("[data-clip-id]")).toHaveCount(1);
});

test("QA-P2-1: renaming a project that is open in another tab is refused, and the owner tab keeps its edits", async ({ browser }) => {
  const context = await browser.newContext();
  const a = await context.newPage();
  await projectWithAsset(a);
  await a.getByRole("button", { name: "Add qa-a.webm to timeline" }).click({ force: true });
  await a.waitForTimeout(2000);
  const b = await context.newPage();
  await b.goto("/#/projects");
  await b.getByRole("button", { name: "Actions for New project", exact: true }).click({ force: true });
  await b.getByRole("menuitem", { name: "Rename" }).click();
  await b.locator("#rename-input").fill("RenamedByB");
  await b.locator("#rename-input").press("Enter");
  await expect(b.getByText("This project is open in another tab")).toBeVisible();
  await a.locator("body").click({ position: { x: 5, y: 5 } });
  await a.keyboard.press("Home");
  await a.keyboard.press("l");
  await a.locator("[data-clip-id]").first().click();
  await a.keyboard.press("s");
  await a.waitForTimeout(2500);
  await b.reload();
  await expect(b.getByRole("group", { name: "Project New project" })).toBeVisible();
  await expect(b.getByText("RenamedByB")).toHaveCount(0);
  await a.getByRole("button", { name: "Project menu" }).click();
  await a.getByRole("menuitem", { name: "Exit project" }).click();
  await expect(a.getByRole("group", { name: "Project New project" })).toBeVisible();
  await b.reload();
  await b.getByRole("button", { name: "Actions for New project", exact: true }).click({ force: true });
  await b.getByRole("menuitem", { name: "Rename" }).click();
  await b.locator("#rename-input").fill("RenamedAfterClose");
  await b.locator("#rename-input").press("Enter");
  await expect(b.getByText("RenamedAfterClose")).toBeVisible();
  await context.close();
});

async function exitAndCorrupt(page: import("@playwright/test").Page, json: string): Promise<void> {
  await projectWithAsset(page);
  await page.waitForTimeout(1500);
  await page.getByRole("button", { name: "Project menu" }).click();
  await page.getByRole("menuitem", { name: "Exit project" }).click();
  await expect(page.getByRole("group", { name: "Project New project" })).toBeVisible();
  await page.evaluate(async (raw) => {
    const db: IDBDatabase = await new Promise((res) => { const r = indexedDB.open("runitback"); r.onsuccess = () => res(r.result); });
    const tx = db.transaction("projects", "readwrite");
    const store = tx.objectStore("projects");
    const keys: IDBValidKey[] = await new Promise((res) => { const r = store.getAllKeys(); r.onsuccess = () => res(r.result); });
    store.put({ id: keys[0], json: raw });
    await new Promise((r) => { tx.oncomplete = r; });
    db.close();
  }, json);
  await page.reload();
}

test("QA-P2-5: a damaged project is surfaced with Retry, Export raw and Delete, not an empty library", async ({ page }) => {
  await exitAndCorrupt(page, "{{{");
  await expect(page.getByText("No projects yet")).toHaveCount(0);
  const card = page.getByRole("group", { name: /Unreadable project/ });
  await expect(card.getByText("Cannot open: damaged")).toBeVisible();
  const download = page.waitForEvent("download");
  await card.getByRole("button", { name: "Export raw" }).click();
  const file = await download;
  expect(await (await import("node:fs/promises")).readFile(await file.path(), "utf8")).toBe("{{{");
  await card.getByRole("button", { name: "Retry" }).click();
  await expect(card).toBeVisible();
  await card.getByRole("button", { name: "Delete" }).click();
  await page.getByRole("button", { name: "Delete project" }).click();
  await expect(page.getByRole("group", { name: /Unreadable project/ })).toHaveCount(0);
  await expect(page.getByText("No projects yet")).toBeVisible();
});

test("QA-P2-5b: a project saved by a newer version says so and is not deleted until asked", async ({ page }) => {
  await exitAndCorrupt(page, JSON.stringify({ version: 999, metadata: { id: "x", name: "From the future" }, scenes: [] }));
  const card = page.getByRole("group", { name: "Unreadable project From the future" });
  await expect(card.getByText("Cannot open: saved by a newer version")).toBeVisible();
  await page.reload();
  await expect(card).toBeVisible();
});
