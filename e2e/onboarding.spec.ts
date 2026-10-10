import { expect, test } from "@playwright/test";
import { importGenerated, makeWebm } from "./media";

const hint = (page: import("@playwright/test").Page) => page.getByTestId("onboarding-hint");

test("first-run onboarding hint: visible on empty project, dismiss persists across reload, hidden once a clip is added", async ({ page }) => {
  await page.goto("/#/projects");
  await page.getByRole("button", { name: /New project|Create your first project/ }).first().click();
  await expect(page.getByLabel("Project name")).toBeVisible();

  await expect(hint(page)).toBeVisible();
  await expect(hint(page)).toContainText("Import");
  await expect(hint(page)).toContainText("Transcribe");
  await expect(hint(page)).toContainText("Index visuals");
  await expect(hint(page)).toContainText("Agent");

  await hint(page).getByRole("button", { name: "Dismiss" }).click();
  await expect(hint(page)).toBeHidden();

  await page.waitForTimeout(1500);
  await page.reload();
  await expect(page.getByLabel("Project name")).toBeVisible();
  await expect(hint(page)).toBeHidden();
});

test("first-run onboarding hint: hidden once the timeline has an element, even without dismissing", async ({ page }) => {
  await page.goto("/#/projects");
  await page.getByRole("button", { name: /New project|Create your first project/ }).first().click();
  await expect(page.getByLabel("Project name")).toBeVisible();
  await expect(hint(page)).toBeVisible();

  await makeWebm(page, { seconds: 2, hue: 10, name: "clip-a.webm" });
  await importGenerated(page);
  await expect(page.getByRole("group", { name: /video clip-a.webm/ })).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "Add clip-a.webm to timeline" }).click({ force: true });
  await expect(page.locator("[data-clip-id]")).toHaveCount(1);

  await expect(hint(page)).toBeHidden();
});
