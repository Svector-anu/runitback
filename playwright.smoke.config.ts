import { defineConfig } from "@playwright/test";

// Live-deploy smoke check: targets an absolute SMOKE_URL, so there is deliberately no webServer and no baseURL.
export default defineConfig({
  testDir: "e2e",
  testMatch: "smoke-live.spec.ts",
  timeout: 120_000,
  workers: 1,
  reporter: [["list"]],
  outputDir: "e2e/.artifacts",
  use: { viewport: { width: 1440, height: 900 }, trace: "retain-on-failure" },
});
