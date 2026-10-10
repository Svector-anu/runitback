import { expect, test } from "@playwright/test";
import { importGenerated, makeWebm } from "./media";

test("first asset dropped on an empty timeline starts at 0 on the main track and renders", async ({ page }) => {
  await page.goto("/#/projects");
  await page.getByRole("button", { name: /New project|Create your first project/ }).first().click();
  await expect(page.getByLabel("Project name")).toBeVisible();
  await makeWebm(page, { seconds: 4, hue: 10, name: "drop-a.webm" });
  await importGenerated(page);
  const tile = page.getByRole("group", { name: /video drop-a.webm/ });
  await expect(tile).toBeVisible({ timeout: 30_000 });

  await tile.dragTo(page.locator(".timeline__body"), { targetPosition: { x: 500, y: 104 } });

  const clip = page.locator("[data-clip-id]");
  await expect(clip).toHaveCount(1);
  await expect(clip).toHaveAttribute("data-start", "0");
  // Only the main track exists (no overlay track was created for the drop position).
  await expect(page.locator(".track-row")).toHaveCount(1);
  await expect(page.locator(".track-row")).toHaveAttribute("data-track-id", (await clip.getAttribute("data-track-id")) ?? "");

  await expect.poll(() => page.evaluate(() => {
    const c = document.querySelector<HTMLCanvasElement>(".preview__scene canvas");
    if (!c) return [0, 0, 0];
    const ctx = c.getContext("2d") as CanvasRenderingContext2D;
    return Array.from(ctx.getImageData(Math.floor(c.width / 2), Math.floor(c.height / 2), 1, 1).data.slice(0, 3));
  })).not.toEqual([0, 0, 0]);
});
