import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = join(__dirname, "..", "src");

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? files(full) : /\.(ts|tsx)$/.test(name) ? [full] : [];
  });
}

const imports = (file: string): string[] =>
  [...readFileSync(file, "utf8").matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1] as string);

const layerOf = (specifier: string): string | null => {
  const m = /^#\/([a-z]+)/.exec(specifier);
  return m?.[1] ?? null;
};

/** Layers may import only from these layers (plus themselves). */
const ALLOWED: Record<string, string[]> = {
  engine: ["engine"],
  templates: ["engine", "templates"],
  render: ["engine", "render"],
  platform: ["engine", "render", "platform"],
  export: ["engine", "render", "platform", "export"],
  app: ["engine", "render", "platform", "export", "templates", "app", "ui"],
  ui: ["engine", "render", "platform", "export", "templates", "app", "ui"],
};

describe("architecture", () => {
  const all = files(SRC);

  it("every layer imports only from layers below it", () => {
    const violations: string[] = [];
    for (const file of all) {
      const layer = relative(SRC, file).split("/")[0] as string;
      if (!ALLOWED[layer]) continue;
      for (const spec of imports(file)) {
        const target = layerOf(spec);
        if (target && ALLOWED[layer] && !ALLOWED[layer].includes(target)) violations.push(`${relative(SRC, file)} -> ${spec}`);
      }
    }
    expect(violations).toEqual([]);
  });

  it("the engine has no DOM, React, storage or audio dependencies", () => {
    const forbidden = /\b(window|document|localStorage|indexedDB|AudioContext|OffscreenCanvas|HTMLCanvasElement|navigator)\b/;
    const offenders = all.filter((f) => relative(SRC, f).startsWith("engine/"))
      .filter((f) => forbidden.test(readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "")) || imports(f).some((s) => s === "react" || s.startsWith("react-")));
    expect(offenders.map((f) => relative(SRC, f))).toEqual([]);
  });

  it("only the prefs store touches localStorage", () => {
    const offenders = all.filter((f) => /\blocalStorage\b/.test(readFileSync(f, "utf8"))).map((f) => relative(SRC, f));
    expect(offenders).toEqual(["platform/prefs.ts"]);
  });

  it("never opts out of the type system", () => {
    const offenders = all.filter((f) => /@ts-ignore|@ts-expect-error|\bas any\b|:\s*any\b/.test(readFileSync(f, "utf8"))).map((f) => relative(SRC, f));
    expect(offenders).toEqual([]);
  });

  it("no stray debugging output in shipped code", () => {
    const offenders = all.filter((f) => /console\.log\(/.test(readFileSync(f, "utf8"))).map((f) => relative(SRC, f));
    expect(offenders).toEqual([]);
  });
});
