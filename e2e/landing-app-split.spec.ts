import { expect, test } from "@playwright/test";

test("/ shows the agent-native landing page", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Tell your video editor what to do" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Start editing" })).toBeVisible();
});

test("/app shows the app shell, defaulting to the projects list", async ({ page }) => {
  await page.goto("/app");
  await expect(page.getByRole("button", { name: /New project|Create your first project/ }).first()).toBeVisible();
});

test("/#/projects still resolves to the app shell (regression guard)", async ({ page }) => {
  await page.goto("/#/projects");
  await expect(page.getByRole("button", { name: /New project|Create your first project/ }).first()).toBeVisible();
});
