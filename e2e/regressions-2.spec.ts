import { expect, test, type Page } from "@playwright/test";
import { importGenerated, makeWebm } from "./media";

const clips = (page: Page) => page.locator("[data-clip-id]");

async function newProject(page: Page): Promise<string> {
  await page.goto("/#/projects");
  await page.getByRole("button", { name: /Create your first project|New project/ }).first().click();
  await expect(page.getByLabel("Project name")).toBeVisible();
  return new URL(page.url()).hash.split("/").pop() as string;
}

const clipTops = (page: Page): Promise<number[]> =>
  page.evaluate(() => [...document.querySelectorAll("[data-clip-id]")].map((el) => Math.round(el.getBoundingClientRect().top)));

test("caption import: overlapping cues land on separate tracks in one undo step", async ({ page }) => {
  await newProject(page);
  await page.getByRole("tab", { name: "Captions" }).click();
  const srt = [
    "1\n00:00:00,000 --> 00:00:04,000\nfirst", "2\n00:00:02,000 --> 00:00:06,000\noverlaps first",
    "3\n00:00:03,000 --> 00:00:05,000\noverlaps both", "4\n00:00:07,000 --> 00:00:08,000\nalone",
  ].join("\n\n");
  await page.getByLabel("Import subtitle file").setInputFiles({ name: "overlap.srt", mimeType: "text/plain", buffer: Buffer.from(srt) });

  await expect(page.getByText("Added 4 captions")).toBeVisible();
  await expect(clips(page)).toHaveCount(4);
  const distinctRows = new Set(await clipTops(page));
  expect(distinctRows.size).toBe(3);

  await page.keyboard.press("ControlOrMeta+z");
  await expect(clips(page)).toHaveCount(0);
});

test("P1-14: a damaged project opens, is repaired once and reports it with a toast", async ({ page }) => {
  const id = await newProject(page);
  await page.getByRole("button", { name: "Project menu" }).click();
  await page.getByRole("menuitem", { name: "Exit project" }).click();
  await expect(page.getByRole("button", { name: /New project/ }).first()).toBeVisible();

  await page.evaluate(async (projectId) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("runitback");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const row = await new Promise<{ id: string; json: string }>((resolve, reject) => {
      const request = db.transaction("projects").objectStore("projects").get(projectId);
      request.onsuccess = () => resolve(request.result as { id: string; json: string });
      request.onerror = () => reject(request.error);
    });
    const project = JSON.parse(row.json) as { scenes: Array<{ tracks: { overlay: unknown[] } }> };
    const text = (elementId: string, start: number, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
      id: elementId, type: "text", name: elementId, startTime: start, duration: 480000, trimStart: 0, trimEnd: 0,
      params: { content: elementId, fontSize: 15, "transform.positionX": null }, ...extra,
    });
    project.scenes[0]?.tracks.overlay.push({
      id: "damaged-track", name: "Text", type: "text", hidden: false,
      elements: [text("one", 0), text("two", 240000, { startTime: 240000 }), text("three", -9000)],
    });
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("projects", "readwrite");
      tx.objectStore("projects").put({ id: projectId, json: JSON.stringify(project) });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  }, id);

  await page.reload();
  await page.goto(`/#/editor/${id}`);
  await expect(page.getByLabel("Project name")).toBeVisible();
  await expect(page.getByText(/Repaired \d+ issues? in this project/)).toBeVisible();
  await expect(clips(page)).toHaveCount(3);
  expect(new Set(await clipTops(page)).size).toBe(3);

  await page.getByRole("button", { name: "Project menu" }).click();
  await page.getByRole("menuitem", { name: "Exit project" }).click();
  await expect(page.getByRole("button", { name: /New project/ }).first()).toBeVisible();
  await page.reload();
  await page.goto(`/#/editor/${id}`);
  await expect(page.getByLabel("Project name")).toBeVisible();
  await expect(clips(page)).toHaveCount(3);
  await expect(page.getByText(/Repaired \d+ issues? in this project/)).toHaveCount(0);
});

test("P1-9: a pointercancel during a scrub releases the playhead and playback works", async ({ page }) => {
  await newProject(page);
  await makeWebm(page, { seconds: 4, hue: 40, name: "clip.webm", withAudio: true });
  await importGenerated(page);
  await page.getByRole("button", { name: "Add clip.webm to timeline" }).click({ force: true });
  await expect(clips(page)).toHaveCount(1);

  const ruler = page.getByRole("slider", { name: "Timeline ruler" });
  const box = (await ruler.boundingBox())!;
  await page.mouse.move(box.x + 60, box.y + 10);
  await page.mouse.down();
  await page.mouse.move(box.x + 120, box.y + 10);
  await page.evaluate(() => window.dispatchEvent(new PointerEvent("pointercancel", { bubbles: true })));
  await page.mouse.move(box.x + 300, box.y + 10);
  const secondsAfterCancel = await page.evaluate(() => Number(document.querySelector(".playhead")?.getAttribute("data-seconds")));
  await page.mouse.move(box.x + 400, box.y + 10);
  expect(await page.evaluate(() => Number(document.querySelector(".playhead")?.getAttribute("data-seconds")))).toBe(secondsAfterCancel);
  await page.mouse.up();

  await page.getByRole("button", { name: "Play", exact: true }).click();
  await expect(page.getByRole("button", { name: "Pause", exact: true })).toBeVisible();
});
