import { defineConfig } from "@playwright/test";

// Production mode (the CI "e2e-production" job, also usable locally) builds the app and runs e2e/production/ plus the
// CSP spec against `vite preview`, which serves the exact headers from vercel.json. Unset, this config uses the dev server.
// PLAYWRIGHT_PORT moves the server off the default port (needed when several checkouts run e2e at once).
const PRODUCTION = process.env.PLAYWRIGHT_TARGET === "production";
const PORT = Number(process.env.PLAYWRIGHT_PORT ?? (PRODUCTION ? 5198 : 5199));
const ORIGIN = `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: "e2e",
  testMatch: PRODUCTION ? ["production/**/*.spec.ts", "csp.spec.ts"] : undefined,
  testIgnore: PRODUCTION ? undefined : ["production/**", "csp.spec.ts"],
  timeout: 120_000,
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  outputDir: "e2e/.artifacts",
  use: {
    baseURL: ORIGIN,
    viewport: { width: 1440, height: 900 },
    trace: "retain-on-failure",
  },
  webServer: PRODUCTION
    ? { command: `node_modules/.bin/vite build && node_modules/.bin/vite preview --port ${PORT} --host 127.0.0.1 --strictPort`, url: ORIGIN, reuseExistingServer: !process.env.CI, timeout: 120_000 }
    : { command: `node_modules/.bin/vite --port ${PORT} --host 127.0.0.1 --strictPort`, url: ORIGIN, reuseExistingServer: true, timeout: 60_000 },
});
