import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "e2e",
  timeout: 120_000,
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  outputDir: "e2e/.artifacts",
  use: { baseURL: "http://127.0.0.1:5199", viewport: { width: 1440, height: 900 }, trace: "retain-on-failure" },
  webServer: { command: "pnpm vite --port 5199 --host 127.0.0.1 --strictPort", url: "http://127.0.0.1:5199", reuseExistingServer: true, timeout: 60_000 },
});
