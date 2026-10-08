import { readFileSync } from "node:fs";
import { test } from "@playwright/test";

/**
 * Opt-in measurement of the REAL image model on real footage. Local files only (nothing is uploaded; the model is
 * downloaded from Hugging Face). `FOOTAGE_CASES` points at a JSON file:
 * `{ "assets": { "<key>": { "path": "...", "durationSeconds": 80 } }, "queries": [{ "asset": "<key>", "query": "...", "truth": [from, to] }] }`
 * where `truth` is the source-time range a human checked the query should hit.
 */
const CASES = process.env.FOOTAGE_CASES;
test.skip(!CASES, "set FOOTAGE_CASES to run the real-footage measurement");
test.setTimeout(1_800_000);

interface CaseFile {
  assets: Record<string, { path: string; durationSeconds: number }>;
  queries: Array<{ asset: string; query: string; truth: [number, number] }>;
}

test("real CLIP on real footage: do the top hits land in the human-checked range?", async ({ page }) => {
  await page.goto("/");
  const spec = JSON.parse(readFileSync(CASES as string, "utf8")) as CaseFile;
  await page.route("**/__footage/*", (route) => {
    const key = new URL(route.request().url()).pathname.split("/").pop() ?? "";
    const asset = spec.assets[key];
    return asset ? route.fulfill({ path: asset.path, contentType: "video/mp4" }) : route.abort();
  });
  const files = Object.fromEntries(Object.entries(spec.assets).map(([key, a]) => [key, { durationSeconds: a.durationSeconds }]));
  const result = await page.evaluate(async ({ files, queries }) => {
    const { createClipIndexer } = (await import(/* @vite-ignore */ "/src/platform/visual/indexer.ts")) as typeof import("../src/platform/visual/indexer");
    const { createClipSearcher } = (await import(/* @vite-ignore */ "/src/platform/visual/searcher.ts")) as typeof import("../src/platform/visual/searcher");
    const engine = (await import(/* @vite-ignore */ "/src/engine/visual/index.ts")) as typeof import("../src/engine/visual");
    const embeddings: Record<string, Awaited<ReturnType<ReturnType<typeof createClipIndexer>["index"]>>> = {};
    for (const [key, f] of Object.entries(files)) {
      const file = new File([await (await fetch(`/__footage/${key}`)).blob()], `${key}.mp4`, { type: "video/mp4" });
      embeddings[key] = await createClipIndexer({ getVideo: () => file, getFootage: async () => ({ durationSeconds: f.durationSeconds, cutTimes: [] }) }).index({ assetId: key });
    }
    const searcher = createClipSearcher();
    const out = [];
    for (const q of queries) {
      const emb = embeddings[q.asset];
      if (!emb) continue;
      const scores = engine.scoreFrames(emb, await searcher.embedText(q.query));
      const rows = scores.map((s, i) => ({ t: emb.times[i] ?? 0, s, inside: (emb.times[i] ?? 0) >= q.truth[0] && (emb.times[i] ?? 0) <= q.truth[1] }));
      const ranked = [...rows].sort((a, b) => b.s - a.s);
      const mean = (xs: number[]): number => (xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length);
      const inside = rows.filter((r) => r.inside).map((r) => r.s);
      const outside = rows.filter((r) => !r.inside).map((r) => r.s);
      let wins = 0, pairs = 0;
      for (const i of inside) for (const o of outside) { pairs++; if (i > o) wins++; }
      out.push({
        asset: q.asset, query: q.query, frames: rows.length, truthFrames: inside.length,
        top1Inside: ranked[0]?.inside ?? false, top3Inside: ranked.slice(0, 3).filter((r) => r.inside).length,
        auc: pairs === 0 ? null : Math.round((wins / pairs) * 100) / 100,
        meanInside: Math.round(mean(inside) * 1000) / 1000, meanOutside: Math.round(mean(outside) * 1000) / 1000,
        top3: ranked.slice(0, 3).map((r) => `${Math.round(r.t)}s:${r.s.toFixed(3)}`),
      });
    }
    searcher.dispose();
    return out;
  }, { files, queries: spec.queries });
  console.log(JSON.stringify(result));
});
