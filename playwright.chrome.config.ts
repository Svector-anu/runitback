import { defineConfig } from "@playwright/test";
import base from "./playwright.config";

// The same specs against the installed Google Chrome (real WebCodecs/Web Audio stack) instead of bundled Chromium.
export default defineConfig({
  ...base,
  use: { ...base.use, channel: "chrome" },
});
