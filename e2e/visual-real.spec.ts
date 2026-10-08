import { expect, test } from "@playwright/test";

/**
 * Opt-in end-to-end check of the REAL image model: downloads about 156 MB from Hugging Face on every run (the browser
 * profile is fresh), so it is skipped unless `REAL_CLIP=1`. Solid red and solid blue frames must be found by the
 * queries "red" and "blue" through the real worker, the self-hosted ONNX runtime and the real frame decoder.
 */
test.skip(process.env.REAL_CLIP !== "1", "set REAL_CLIP=1 to download and run the real CLIP model");
test.setTimeout(900_000);

const ENTRY_URL = "/evals/browser-entry.ts";
const INDEXER_URL = "/src/platform/visual/indexer.ts";
const SEARCHER_URL = "/src/platform/visual/searcher.ts";
const ENGINE_URL = "/src/engine/visual/index.ts";

interface Measurement {
  model: string;
  dimensions: number;
  times: number[];
  progress: number[];
  scores: Record<string, number[]>;
  vectorNorms: number[];
}

test("the real CLIP model tells a red screen from a blue one", async ({ page }) => {
  await page.goto("/");
  const measurement = await page.evaluate(async ({ entryUrl, indexerUrl, searcherUrl, engineUrl }): Promise<Measurement> => {
    const entry = (await import(/* @vite-ignore */ entryUrl)) as typeof import("../evals/browser-entry");
    const { createClipIndexer } = (await import(/* @vite-ignore */ indexerUrl)) as typeof import("../src/platform/visual/indexer");
    const { createClipSearcher } = (await import(/* @vite-ignore */ searcherUrl)) as typeof import("../src/platform/visual/searcher");
    const engine = (await import(/* @vite-ignore */ engineUrl)) as typeof import("../src/engine/visual");
    const file = await entry.generateFixtureFile({
      id: "colors", name: "colors.webm", kind: "video", durationSeconds: 6, audio: { kind: "none" },
      blocks: [{ seconds: 3, rgb: [220, 30, 30] }, { seconds: 3, rgb: [30, 60, 230] }],
    });
    const progress: number[] = [];
    const indexer = createClipIndexer({ getVideo: () => file, getFootage: async () => ({ durationSeconds: 6, cutTimes: [3] }) });
    const embeddings = await indexer.index({ assetId: "colors", onProgress: (f) => progress.push(f) });
    const searcher = createClipSearcher();
    const scores: Record<string, number[]> = {};
    for (const query of ["red", "blue", "a red screen", "a blue screen"]) scores[query] = engine.scoreFrames(embeddings, await searcher.embedText(query));
    searcher.dispose();
    const vectorNorms = embeddings.times.map((_, row) => Math.hypot(...embeddings.vectors.slice(row * embeddings.dimensions, (row + 1) * embeddings.dimensions)));
    return { model: embeddings.model, dimensions: embeddings.dimensions, times: embeddings.times, progress, scores, vectorNorms };
  }, { entryUrl: ENTRY_URL, indexerUrl: INDEXER_URL, searcherUrl: SEARCHER_URL, engineUrl: ENGINE_URL });

  console.log(JSON.stringify(measurement, null, 1));
  expect(measurement.model).toBe("Xenova/clip-vit-base-patch32");
  expect(measurement.dimensions).toBe(512);
  for (const norm of measurement.vectorNorms) expect(norm).toBeCloseTo(1, 3);
  expect([...measurement.progress].sort((a, b) => a - b)).toEqual(measurement.progress);

  const mean = (values: number[]): number => values.reduce((a, b) => a + b, 0) / values.length;
  const redFrames = measurement.times.map((t, i) => (t < 3 ? i : -1)).filter((i) => i >= 0);
  const blueFrames = measurement.times.map((t, i) => (t >= 3 ? i : -1)).filter((i) => i >= 0);
  const over = (query: string, rows: number[]): number => mean(rows.map((i) => (measurement.scores[query] ?? [])[i] ?? 0));
  for (const [redQuery, blueQuery] of [["red", "blue"], ["a red screen", "a blue screen"]] as const) {
    expect(over(redQuery, redFrames), `"${redQuery}" scores red frames above blue frames`).toBeGreaterThan(over(redQuery, blueFrames));
    expect(over(blueQuery, blueFrames), `"${blueQuery}" scores blue frames above red frames`).toBeGreaterThan(over(blueQuery, redFrames));
  }
});
