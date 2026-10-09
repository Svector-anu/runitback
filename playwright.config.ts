import { defineConfig } from "@playwright/test";

// Set by the CI "e2e-production" job (and usable locally) to run the core subset in
// e2e/production/ against `vite preview`'s static `dist/` build instead of the dev server.
// Unset, this config is unchanged from the dev-server setup the existing e2e job already uses.
const PRODUCTION = process.env.PLAYWRIGHT_TARGET === "production";

export default defineConfig({
  testDir: PRODUCTION ? "e2e/production" : "e2e",
  testIgnore: PRODUCTION ? undefined : ["production/**"],
  timeout: 120_000,
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  outputDir: "e2e/.artifacts",
  use: {
    baseURL: PRODUCTION ? "http://127.0.0.1:5198" : "http://127.0.0.1:5199",
    viewport: { width: 1440, height: 900 },
    trace: "retain-on-failure",
  },
  webServer: PRODUCTION
    ? { command: "pnpm vite preview --port 5198 --host 127.0.0.1 --strictPort", url: "http://127.0.0.1:5198", reuseExistingServer: true, timeout: 60_000 }
    : { command: "pnpm vite --port 5199 --host 127.0.0.1 --strictPort", url: "http://127.0.0.1:5199", reuseExistingServer: true, timeout: 60_000 },
});
