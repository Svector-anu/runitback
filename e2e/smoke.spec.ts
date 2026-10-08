import { expect, test } from "@playwright/test";
import { importGenerated, makeWebm } from "./media";

test("create project, import, place on timeline", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  await page.goto("/#/projects");
  await expect(page.getByText("No projects yet")).toBeVisible();
  await page.getByRole("button", { name: "Create your first project" }).click();
  await expect(page.getByLabel("Project name")).toBeVisible();
  await page.screenshot({ path: "e2e/.artifacts/empty-editor.png" });
  await makeWebm(page, { seconds: 4, hue: 10, name: "clip-a.webm", withAudio: true });
  await importGenerated(page);
  await expect(page.getByRole("group", { name: /video clip-a.webm/ })).toBeVisible({ timeout: 30_000 });
  await page.screenshot({ path: "e2e/.artifacts/imported.png" });
  console.log("errors", errors);
});
