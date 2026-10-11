import { defineConfig, type Plugin } from "vitest/config";
import react from "@vitejs/plugin-react";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

interface VercelHeaderRule {
  source: string;
  headers: { key: string; value: string }[];
}

/**
 * `vite preview` serves the production bundle with the exact headers from vercel.json, so the CSP e2e (and any local
 * production check) exercises what Vercel will send. vercel.json is the single source of truth. The dev server is
 * left alone: HMR and React Refresh need inline scripts and a websocket that a strict CSP forbids.
 */
function vercelHeaders(): Plugin {
  return {
    name: "runitback:vercel-headers",
    apply: "serve",
    configurePreviewServer(server) {
      const config = JSON.parse(readFileSync(fileURLToPath(new URL("./vercel.json", import.meta.url)), "utf8")) as { headers?: VercelHeaderRule[] };
      const rules = (config.headers ?? []).map((rule) => ({ pattern: new RegExp(`^${rule.source}$`), headers: rule.headers }));
      server.middlewares.use((request, response, next) => {
        const path = (request.url ?? "/").split("?")[0] ?? "/";
        for (const rule of rules) {
          if (rule.pattern.test(path)) for (const { key, value } of rule.headers) response.setHeader(key, value);
        }
        next();
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), vercelHeaders()],
  // mediabunny (probe, decode, encode, mux) is the single large dependency; the editor route is already split out.
  build: { chunkSizeWarningLimit: 900 },
  resolve: { alias: { "#": fileURLToPath(new URL("./src", import.meta.url)) } },
  test: {
    include: ["tests/**/*.test.{ts,tsx}"],
    environment: "node",
  },
});
