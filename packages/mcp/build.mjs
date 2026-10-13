// Builds dist/server.js from tools/mcp with Vite's SSR build (Vite is already a dev dependency, so no new tooling).
// First-party code and the shared protocol module are bundled; `ws` and the MCP SDK stay external and are declared as
// dependencies in package.json, so `npx` installs them.
import { copyFileSync, chmodSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { build } from "vite";

const here = (path) => fileURLToPath(new URL(path, import.meta.url));
const root = here("../..");
const out = here("./dist");

await build({
  root,
  configFile: false,
  publicDir: false,
  logLevel: "warn",
  resolve: { alias: { "#": `${root}/src` } },
  build: {
    ssr: `${root}/tools/mcp/server.ts`,
    outDir: out,
    emptyOutDir: true,
    target: "node20",
    minify: false,
    sourcemap: false,
    rollupOptions: { output: { format: "es", entryFileNames: "server.js" } },
  },
  ssr: { noExternal: [], external: ["ws", "@modelcontextprotocol/sdk"] },
});

const file = `${out}/server.js`;
const code = readFileSync(file, "utf8");
if (!code.startsWith("#!")) writeFileSync(file, `#!/usr/bin/env node\n${code}`);
chmodSync(file, 0o755);
copyFileSync(`${root}/LICENSE`, here("./LICENSE"));
console.log(`built ${file}`);
