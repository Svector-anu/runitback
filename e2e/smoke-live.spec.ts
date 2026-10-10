import { expect, test } from "@playwright/test";

/**
 * Post-deploy smoke check: loads a live URL (production deploy, or a local `vite preview` as a
 * stand-in) headlessly, creates a project and confirms the editor actually mounted — not just
 * that the server answered with 200. `SMOKE_URL` makes this target any deployed URL instead of
 * the baseURL hardcoded in playwright.config.ts; `VERCEL_AUTOMATION_BYPASS_SECRET`, when set,
 * carries Vercel's Deployment Protection bypass header so the request reaches the app instead of
 * the Vercel login page. CI only runs this spec once it has both an `SMOKE_URL` (the deploy job's
 * deployment_status payload) and the bypass secret, see `.github/workflows/smoke.yml`, so skip
 * here only guards against this spec running unintentionally inside a plain CI job that has
 * neither.
 */
const TARGET_URL = process.env.SMOKE_URL;
const BYPASS_SECRET = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;

test.skip(!TARGET_URL && !!process.env.CI, "set SMOKE_URL to a deployed URL to run this in CI; it auto-runs locally against the configured baseURL as a stand-in proof");

test("smoke: deployed editor creates a project and mounts", async ({ page }) => {
  if (BYPASS_SECRET) await page.setExtraHTTPHeaders({ "x-vercel-protection-bypass": BYPASS_SECRET });
  const base = TARGET_URL ? TARGET_URL.replace(/\/+$/, "") : "";

  await page.goto(`${base}/#/projects`);
  await expect(page.getByText("No projects yet")).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "Create your first project" }).click();

  // Both only render once EditorPage.tsx's `ready` state flips true and the full editor layout
  // mounts (see EditorPage's "loading" vs. ready branches) — a real mount signal, not an HTTP code.
  await expect(page.getByLabel("Project name")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("preview-viewport")).toBeVisible({ timeout: 30_000 });
});
