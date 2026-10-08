import { expect, test, type Page } from "@playwright/test";
import { importGenerated, makeWebm } from "./media";

const clips = (page: Page) => page.locator("[data-clip-id]");
const previewPixel = (page: Page) => page.evaluate(() => {
  const c = document.querySelector<HTMLCanvasElement>(".preview__scene canvas");
  if (!c) throw new Error("no canvas");
  const ctx = c.getContext("2d") as CanvasRenderingContext2D;
  return Array.from(ctx.getImageData(10, 10, 1, 1).data.slice(0, 3));
});
const currentSeconds = (page: Page) => page.evaluate(() => Number(document.querySelector(".playhead")?.getAttribute("data-seconds")));

async function newProjectWithClips(page: Page): Promise<void> {
  await page.goto("/#/projects");
  await page.getByRole("button", { name: /New project|Create your first project/ }).first().click();
  await expect(page.getByLabel("Project name")).toBeVisible();
  await makeWebm(page, { seconds: 4, hue: 10, name: "clip-a.webm", withAudio: true });
  await makeWebm(page, { seconds: 3, hue: 200, name: "clip-b.webm" });
  await importGenerated(page);
  await expect(page.getByRole("group", { name: /video clip-a.webm/ })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("group", { name: /video clip-b.webm/ })).toBeVisible();
}

test.describe("editor flow", () => {
  test("import → timeline → edit → undo/redo → play → persist", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await newProjectWithClips(page);

    await page.getByRole("button", { name: "Add clip-a.webm to timeline" }).click({ force: true });
    await expect(clips(page)).toHaveCount(1);
    await page.getByRole("button", { name: "Add clip-b.webm to timeline" }).click({ force: true });
    await expect(clips(page)).toHaveCount(2);

    // Preview reflects the composition at the playhead.
    await expect.poll(() => previewPixel(page)).not.toEqual([0, 0, 0]);
    const first = await previewPixel(page);

    // Split at 1s with the keyboard.
    await page.locator("body").click({ position: { x: 5, y: 5 } });
    await page.keyboard.press("Home");
    await page.keyboard.press("l");
    await expect.poll(() => currentSeconds(page)).toBeCloseTo(1, 1);
    await clips(page).first().click();
    await page.keyboard.press("s");
    await expect(clips(page)).toHaveCount(3);

    // Undo and redo restore exact state.
    await page.keyboard.press("ControlOrMeta+z");
    await expect(clips(page)).toHaveCount(2);
    await page.keyboard.press("ControlOrMeta+Shift+z");
    await expect(clips(page)).toHaveCount(3);

    // Delete the selected piece, then undo.
    await page.keyboard.press("Delete");
    await expect(clips(page)).toHaveCount(2);
    await page.keyboard.press("ControlOrMeta+z");
    await expect(clips(page)).toHaveCount(3);

    // Playback advances the playhead and changes the rendered frame.
    await page.keyboard.press("Home");
    await page.keyboard.press("Space");
    await page.waitForTimeout(1200);
    await page.keyboard.press("Space");
    expect(await currentSeconds(page)).toBeGreaterThan(0.5);
    await expect.poll(() => previewPixel(page)).not.toEqual(first);

    // Autosave then reload restores the project.
    await page.waitForTimeout(1500);
    await page.reload();
    await expect(page.getByLabel("Project name")).toBeVisible();
    await expect(clips(page)).toHaveCount(3, { timeout: 20_000 });
    expect(errors.filter((e) => !/Mediabunny was loaded twice/.test(e))).toEqual([]);
  });

  test("drag moves a clip to a new track without overlap; trim handle shortens it", async ({ page }) => {
    await newProjectWithClips(page);
    await page.getByRole("button", { name: "Add clip-a.webm to timeline" }).click({ force: true });
    await page.getByRole("button", { name: "Add clip-b.webm to timeline" }).click({ force: true });
    await expect(clips(page)).toHaveCount(2);

    // Trim the selected clip's right edge: duration shrinks, start stays.
    const target = clips(page).last();
    await target.click();
    const meta = async (): Promise<{ start: number; duration: number; track: string }> => target.evaluate((el) => ({
      start: Number(el.getAttribute("data-start")), duration: Number(el.getAttribute("data-duration")), track: el.getAttribute("data-track-id") ?? "",
    }));
    const original = await meta();
    const h = (await page.getByLabel("Right resize handle").boundingBox())!;
    await page.mouse.move(h.x + h.width / 2, h.y + h.height / 2);
    await page.mouse.down();
    await page.mouse.move(h.x - 60, h.y + h.height / 2, { steps: 5 });
    await page.mouse.up();
    const trimmed = await meta();
    expect(trimmed.start).toBe(original.start);
    expect(trimmed.duration).toBeLessThan(original.duration);
    expect(trimmed.duration % 4000).toBe(0);

    // Drag it so it overlaps the other clip: it must land on a different track, never overlapping.
    const b2 = (await target.boundingBox())!;
    await page.mouse.move(b2.x + b2.width / 2, b2.y + b2.height / 2);
    await page.mouse.down();
    await page.mouse.move(b2.x + b2.width / 2 - 100, b2.y + b2.height / 2 + 2, { steps: 8 });
    await page.mouse.up();
    const all = await clips(page).evaluateAll((els) => els.map((e) => ({ id: e.getAttribute("data-clip-id"), start: Number(e.getAttribute("data-start")), duration: Number(e.getAttribute("data-duration")), track: e.getAttribute("data-track-id") })));
    for (const a of all) for (const b of all) {
      if (a.id !== b.id && a.track === b.track) expect(a.start + a.duration <= b.start || b.start + b.duration <= a.start).toBe(true);
    }

    await page.keyboard.press("ControlOrMeta+z");
    await page.keyboard.press("ControlOrMeta+z");
    const restored = await meta().catch(() => null);
    expect(restored?.duration).toBe(original.duration);
  });
});

test("speed tab: Change pitch switch stores maintainPitch and survives reload", async ({ page }) => {
  await newProjectWithClips(page);
  await page.getByRole("button", { name: "Add clip-a.webm to timeline" }).click({ force: true });
  await expect(clips(page)).toHaveCount(1);
  await clips(page).first().click();
  await page.getByRole("tab", { name: "Speed" }).click();

  const changePitch = page.getByRole("switch", { name: "Change pitch" });
  await expect(changePitch).toBeDisabled();

  const speed = page.getByRole("textbox", { name: "Speed" });
  await speed.fill("2");
  await speed.press("Enter");
  await expect(changePitch).toBeEnabled();
  await expect(changePitch).toHaveAttribute("aria-checked", "true");

  await changePitch.click();
  await expect(changePitch).toHaveAttribute("aria-checked", "false");

  await page.waitForTimeout(1500);
  await page.reload();
  await expect(clips(page)).toHaveCount(1, { timeout: 20_000 });
  await clips(page).first().click();
  await page.getByRole("tab", { name: "Speed" }).click();
  await expect(page.getByRole("switch", { name: "Change pitch" })).toHaveAttribute("aria-checked", "false");
});
