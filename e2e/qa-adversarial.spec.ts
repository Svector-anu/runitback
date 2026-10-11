import { expect, test } from "@playwright/test";
import { importGenerated, makeWebm } from "./media";

async function projectWithAsset(page: import("@playwright/test").Page): Promise<void> {
  await page.goto("/#/projects");
  await page.getByRole("button", { name: "Create your first project" }).click();
  await makeWebm(page, { seconds: 2, hue: 40, name: "qa-a.webm", withAudio: false });
  await importGenerated(page);
  await page.getByRole("button", { name: "Add qa-a.webm to timeline" }).waitFor({ state: "attached" });
}

test.fixme("QA-P1-1: Enter on the focused 'Add to timeline' button adds exactly one clip", async ({ page }) => {
  await projectWithAsset(page);
  await page.getByRole("button", { name: "Add qa-a.webm to timeline" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("[data-clip-id]")).toHaveCount(1);
});

test.fixme("QA-P1-1b: Enter on 'Transcribe' does not also add the clip to the timeline", async ({ page }) => {
  await projectWithAsset(page);
  await page.getByRole("button", { name: "Transcribe qa-a.webm" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("[data-clip-id]")).toHaveCount(0);
});

test.fixme("QA-P2-1: renaming a project that is open in another tab is not silently reverted", async ({ browser }) => {
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
  await a.locator("body").click({ position: { x: 5, y: 5 } });
  await a.keyboard.press("Home");
  await a.keyboard.press("l");
  await a.locator("[data-clip-id]").first().click();
  await a.keyboard.press("s");
  await a.waitForTimeout(2500);
  await b.reload();
  await expect(b.getByText("RenamedByB")).toBeVisible();
});

test.fixme("QA-P2-5: a stored project that cannot be read is surfaced, not shown as an empty library", async ({ page }) => {
  await projectWithAsset(page);
  await page.waitForTimeout(1500);
  await page.getByRole("button", { name: "Project menu" }).click();
  await page.getByRole("menuitem", { name: "Exit project" }).click();
  await page.evaluate(async () => {
    const db: IDBDatabase = await new Promise((res) => { const r = indexedDB.open("runitback"); r.onsuccess = () => res(r.result); });
    const tx = db.transaction("projects", "readwrite");
    const store = tx.objectStore("projects");
    const keys: IDBValidKey[] = await new Promise((res) => { const r = store.getAllKeys(); r.onsuccess = () => res(r.result); });
    store.put({ id: keys[0], json: "{{{" });
    await new Promise((r) => { tx.oncomplete = r; });
    db.close();
  });
  await page.reload();
  await expect(page.getByText("No projects yet")).toHaveCount(0);
});
