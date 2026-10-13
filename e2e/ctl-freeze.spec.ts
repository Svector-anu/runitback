import { expect, test, type Page } from "@playwright/test";
import { clipAt, openEditorWithClips, previewPixels, readElements, seekSeconds, selectClip, shot, undo, type Rgb } from "./ctl-support";

test.use({ channel: "chrome" });

const TICKS = 120_000;
const centre = async (page: Page, seconds: number): Promise<Rgb> => {
  await seekSeconds(page, seconds);
  await page.waitForTimeout(300);
  return (await previewPixels(page, [[0.5, 0.5]]))[0] as Rgb;
};
const sorted = async (page: Page) => (await readElements(page)).filter((e) => e.type === "video" || e.type === "image").sort((a, b) => a.startTime - b.startTime);
const distance = (a: Rgb, b: Rgb): number => Math.max(...a.map((v, i) => Math.abs(v - b[i]!)));

test.beforeEach(async ({ page }) => {
  await openEditorWithClips(page, [{ name: "ramp.webm", color: "#000000", seconds: 6, pattern: "ramp" }]);
  await selectClip(page, 0);
});

test("Freeze frame in the clip menu adds a two second still of the playhead frame", async ({ page }) => {
  const before = await centre(page, 2);
  await seekSeconds(page, 2);
  await clipAt(page, 0).click({ button: "right" });
  await expect(page.getByRole("menuitem", { name: "Freeze frame" })).toBeEnabled();
  await shot(page, "freeze-menu");
  await page.getByRole("menuitem", { name: "Freeze frame" }).click();

  await expect.poll(async () => (await sorted(page)).map((e) => e.type)).toEqual(["video", "image", "video"]);
  const [head, still, tail] = await sorted(page);
  expect(head!.duration).toBe(2 * TICKS);
  expect([still!.startTime, still!.duration]).toEqual([2 * TICKS, 2 * TICKS]);
  expect(tail!.startTime).toBe(4 * TICKS);
  await expect(page.getByText("Freeze frame added")).toBeVisible();

  const early = await centre(page, 2.2);
  const late = await centre(page, 3.8);
  expect(distance(early, late)).toBeLessThan(25);
  expect(distance(early, before)).toBeLessThan(40);
  expect(distance(await centre(page, 0.5), early)).toBeGreaterThan(40);
  await shot(page, "freeze-added");

  await undo(page);
  await expect.poll(async () => (await sorted(page)).length).toBe(1);
  expect((await sorted(page))[0]!.duration).toBe(6 * TICKS);
});

test("the toolbar button freezes too; with the playhead outside the clip it explains instead of failing silently", async ({ page }) => {
  await seekSeconds(page, 1);
  await page.getByRole("button", { name: "Freeze frame" }).click();
  await expect.poll(async () => (await sorted(page)).length).toBe(3);
  await undo(page);

  await seekSeconds(page, 7);
  await clipAt(page, 0).click({ button: "right" });
  await expect(page.getByRole("menuitem", { name: /Freeze frame \(playhead outside clip\)/ })).toBeDisabled();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Freeze frame" }).click();
  await expect(page.getByText("Move the playhead inside the clip to freeze that frame")).toBeVisible();
  expect(await sorted(page)).toHaveLength(1);
});

test("a still has no Freeze frame entry; images and text cannot be frozen", async ({ page }) => {
  await seekSeconds(page, 2);
  await page.getByRole("button", { name: "Freeze frame" }).click();
  await expect.poll(async () => (await sorted(page)).length).toBe(3);
  await page.locator(`[data-start="${2 * TICKS}"]`).click({ button: "right" });
  await expect(page.getByRole("menuitem", { name: /Freeze frame/ })).toHaveCount(0);
});
