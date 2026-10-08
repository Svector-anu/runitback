import { expect, test, type Page } from "@playwright/test";
import { importGenerated, makeWebm } from "./media";

const clips = (page: Page) => page.locator("[data-clip-id]");

async function projectWithClip(page: Page, seconds = 4): Promise<void> {
  await page.goto("/#/projects");
  await page.getByRole("button", { name: /Create your first project|New project/ }).first().click();
  await expect(page.getByLabel("Project name")).toBeVisible();
  await makeWebm(page, { seconds, hue: 40, name: "clip.webm", withAudio: true });
  await importGenerated(page);
  await page.getByRole("button", { name: "Add clip.webm to timeline" }).click({ force: true });
  await expect(clips(page)).toHaveCount(1);
}

const heldProjectLocks = (page: Page): Promise<string[]> => page.evaluate(async () => {
  const { held } = await navigator.locks.query();
  return (held ?? []).map((l) => l.name ?? "").filter((n) => n.startsWith("runitback:project:"));
});

test("P1-8: Enter on a focused toolbar button activates it and does not move the playhead", async ({ page }) => {
  await projectWithClip(page);
  const seconds = () => page.evaluate(() => Number(document.querySelector(".playhead")?.getAttribute("data-seconds")));
  const ruler = page.getByRole("slider", { name: "Timeline ruler" });
  const box = (await ruler.boundingBox())!;
  await page.mouse.click(box.x + 160, box.y + 10);
  await expect.poll(seconds).toBeGreaterThan(1);
  const playheadBefore = await seconds();
  const widthBefore = (await clips(page).first().boundingBox())!.width;

  await page.getByRole("button", { name: "Zoom in", exact: true }).focus();
  await page.keyboard.press("Enter");

  await expect.poll(async () => (await clips(page).first().boundingBox())!.width).toBeGreaterThan(widthBefore);
  expect(await seconds()).toBeCloseTo(playheadBefore, 2);
});

test("P1-6: clicking outside the export popover does not cancel the export", async ({ page }) => {
  await projectWithClip(page, 6);
  await page.getByRole("button", { name: "Export", exact: true }).first().click();
  await page.getByRole("button", { name: "Format" }).click();
  await page.getByLabel("WebM (VP9)").check();
  const downloadPromise = page.waitForEvent("download", { timeout: 90_000 });
  await page.getByRole("dialog", { name: "Export project" }).getByRole("button", { name: "Export" }).click();
  await page.mouse.click(5, 5);
  await expect(page.getByRole("dialog", { name: "Export project" })).toHaveCount(0);
  const download = await downloadPromise;
  expect((await download.path()) !== null).toBe(true);
});

test("P1-7: typing in the inspector Content field keeps focus, commits on blur and undoes", async ({ page }) => {
  await projectWithClip(page);
  await page.getByRole("tab", { name: "Text" }).first().click();
  await page.getByRole("button", { name: "Add Default text to timeline" }).click({ force: true });
  await expect(clips(page)).toHaveCount(2);
  const content = page.getByLabel("Content", { exact: true });
  const original = await content.inputValue();
  await content.click();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.type("Hello");
  await expect(content).toBeFocused();
  await expect(content).toHaveValue("Hello");
  await page.getByRole("tab", { name: "Text" }).first().click();
  await expect(content).toHaveValue("Hello");
  await page.keyboard.press("ControlOrMeta+z");
  await expect(content).toHaveValue(original);
});

test("P0-5: a second tab on the same project is blocked until the first leaves", async ({ page, context }) => {
  await projectWithClip(page);
  const url = page.url();
  const other = await context.newPage();
  await other.goto(url);
  await expect(other.getByText("This project is open in another tab")).toBeVisible();
  await expect(other.getByRole("button", { name: "Try again" })).toBeVisible();

  await page.getByRole("button", { name: "Project menu" }).click();
  await page.getByRole("menuitem", { name: "Exit project" }).click();
  await expect(page.getByRole("button", { name: /Create your first project|New project/ }).first()).toBeVisible();
  await other.getByRole("button", { name: "Try again" }).click();
  await expect(other.getByLabel("Project name")).toBeVisible();
});

test("P1-2: rapid project switches leave exactly the last project open and locked", async ({ page }) => {
  await page.goto("/#/projects");
  await page.getByRole("button", { name: /Create your first project|New project/ }).first().click();
  await expect(page.getByLabel("Project name")).toBeVisible();
  const first = new URL(page.url()).hash.split("/").pop() as string;
  await page.getByRole("button", { name: "Project menu" }).click();
  await page.getByRole("menuitem", { name: "Exit project" }).click();
  await page.getByRole("button", { name: /New project/ }).first().click();
  await expect(page.getByLabel("Project name")).toBeVisible();
  const second = new URL(page.url()).hash.split("/").pop() as string;
  expect(second).not.toBe(first);

  await page.evaluate(([a, b]) => {
    location.hash = `#/editor/${a}`;
    location.hash = `#/editor/${b}`;
    location.hash = `#/editor/${a}`;
    location.hash = `#/editor/${b}`;
  }, [first, second]);
  await expect(page.getByLabel("Project name")).toBeVisible();
  await expect.poll(() => heldProjectLocks(page)).toEqual([`runitback:project:${second}`]);
});
