import { expect, test, type Page } from "@playwright/test";
import { callAgentTool, near, openVfxHarness, savePng, type Point, type Rgb } from "./vfx-support";

test.use({ channel: "chrome" });

const ORANGE: Rgb = [255, 160, 0];
const RED: Rgb = [200, 50, 50];
const SKIN: Rgb = [224, 172, 140];
const BACKDROP: Point[] = [[10, 10], [300, 20], [20, 170], [150, 160]];
const SUBJECT: Point = [160, 90];
const PATCH: Point = [250, 120];
const GREEN: Rgb = [0, 255, 0];

const sample = (page: Page, points: Point[], seconds = 1): Promise<Rgb[]> => page.evaluate(({ seconds, points }) => window.__vfx.renderAt(seconds, points), { seconds, points });

async function openScene(page: Page): Promise<void> {
  await openVfxHarness(page, [
    { color: "#ffa000", seconds: 3 },
    { color: "#000000", seconds: 3, pattern: "greenscreen", track: "overlay" },
  ]);
}

test("without a key the green screen covers the footage below", async ({ page }) => {
  await openScene(page);
  const px = await sample(page, BACKDROP);
  for (const p of px) expect(near(p, GREEN, 40)).toBe(true);
});

for (const backend of ["gpu", "cpu"] as const) {
  test(`chroma key (${backend}): screen becomes transparent, subject stays opaque, lower layer shows through`, async ({ page }) => {
    await openScene(page);
    await page.evaluate((b) => window.__vfx.setChromaBackend(b), backend);
    const r = await callAgentTool(page, "set_chroma_key", { elementIds: ["clip-1"] });
    expect(r.ok, r.error).toBe(true);
    const bg = await sample(page, BACKDROP);
    for (const p of bg) expect(near(p, ORANGE, 24), `backdrop ${p}`).toBe(true);
    const [subject, patch] = (await sample(page, [SUBJECT, PATCH])) as [Rgb, Rgb];
    expect(near(subject, RED, 30), `subject ${subject}`).toBe(true);
    expect(near(patch, SKIN, 30), `skin patch ${patch}`).toBe(true);
    expect(await page.evaluate(() => window.__vfx.lastChromaBackend())).toBe(backend);
    const url = await page.evaluate(() => window.__vfx.pngAt(1));
    savePng(`chroma-${backend}`, url);
  });
}

test("GPU and CPU keyers agree to within rounding on every sampled pixel", async ({ page }) => {
  await openScene(page);
  await callAgentTool(page, "set_chroma_key", { elementIds: ["clip-1"], similarity: 35, smoothness: 25, spill: 80 });
  const grid: Point[] = [];
  for (let y = 4; y < 180; y += 12) for (let x = 4; x < 320; x += 10) grid.push([x, y]);
  await page.evaluate(() => window.__vfx.setChromaBackend("cpu"));
  const cpu = await sample(page, grid);
  await page.evaluate(() => window.__vfx.setChromaBackend("gpu"));
  const gpu = await sample(page, grid);
  expect(await page.evaluate(() => window.__vfx.lastChromaBackend())).toBe("gpu");
  let worst = 0;
  for (let i = 0; i < grid.length; i++) for (let c = 0; c < 3; c++) worst = Math.max(worst, Math.abs((cpu[i] as Rgb)[c]! - (gpu[i] as Rgb)[c]!));
  expect(worst).toBeLessThanOrEqual(6);
});

test("key colour, similarity and removal behave through the tool", async ({ page }) => {
  await openScene(page);
  await callAgentTool(page, "set_chroma_key", { elementIds: ["clip-1"], keyColor: "#0000ff" });
  const wrong = await sample(page, BACKDROP);
  for (const p of wrong) expect(near(p, GREEN, 40), "a blue key leaves green alone").toBe(true);
  await callAgentTool(page, "set_chroma_key", { elementIds: ["clip-1"], keyColor: "#00ff00" });
  const keyed = await sample(page, BACKDROP);
  for (const p of keyed) expect(near(p, ORANGE, 24)).toBe(true);
  const removed = await callAgentTool(page, "set_chroma_key", { elementIds: ["clip-1"], remove: true });
  expect(removed.ok, removed.error).toBe(true);
  expect(near((await sample(page, [BACKDROP[0] as Point]))[0] as Rgb, GREEN, 40)).toBe(true);
});

test("decoded export matches the preview: background transparent, subject intact", async ({ page }) => {
  await openScene(page);
  await callAgentTool(page, "set_chroma_key", { elementIds: ["clip-1"] });
  const out = await page.evaluate(() => window.__vfx.exportAt({ times: [0.5, 1.5], points: [[10, 10], [300, 20], [20, 170], [160, 90], [250, 120]] }));
  expect(out.frames).toBeGreaterThan(80);
  for (const frame of out.samples) {
    for (const p of frame.slice(0, 3)) expect(near(p as Rgb, ORANGE, 30), `export backdrop ${p}`).toBe(true);
    expect(near(frame[3] as Rgb, RED, 36)).toBe(true);
    expect(near(frame[4] as Rgb, SKIN, 36)).toBe(true);
  }
});

test("keying 1080p: ms per frame on the GPU and CPU paths", async ({ page }) => {
  await page.goto("/#/projects");
  const result = await page.evaluate(async () => {
    const load = <T>(url: string): Promise<T> => import(/* @vite-ignore */ url) as Promise<T>;
    const [compositorMod] = await Promise.all([load<typeof import("../src/render/compositor")>("/src/render/compositor.ts")]);
    const W = 1920, H = 1080;
    const source = new OffscreenCanvas(W, H);
    const sctx = source.getContext("2d") as OffscreenCanvasRenderingContext2D;
    sctx.fillStyle = "#00ff00"; sctx.fillRect(0, 0, W, H);
    sctx.fillStyle = "#c83232"; sctx.fillRect(700, 250, 500, 600);
    const plan = {
      width: W, height: H, time: 0, backgroundColor: "#000000", missingMedia: [],
      items: [{
        kind: "layer" as const, elementId: "x", opacity: 1, blendMode: "normal" as const, mask: null, crop: null, transition: null,
        effects: [{ type: "chroma-key", params: { keyColor: "#00ff00", similarity: 30, smoothness: 10, spill: 50 } }],
        source: { type: "image" as const, mediaId: "m", width: W, height: H },
        transform: { centerX: W / 2, centerY: H / 2, width: W, height: H, rotationDegrees: 0, flipX: false, flipY: false },
      }],
    };
    const measure = async (backend: "gpu" | "cpu" | "none"): Promise<{ msPerFrame: number; used: string | null }> => {
      const canvas = new OffscreenCanvas(W, H);
      const comp = new compositorMod.Compositor(canvas as unknown as HTMLCanvasElement, { chromaBackend: backend === "none" ? "cpu" : backend });
      const p = backend === "none" ? { ...plan, items: [{ ...plan.items[0]!, effects: [] }] } : plan;
      const sources = { get: () => source as unknown as CanvasImageSource };
      for (let i = 0; i < 5; i++) comp.drawPlan(p as never, sources);
      (canvas.getContext("2d") as OffscreenCanvasRenderingContext2D).getImageData(0, 0, 1, 1);
      const N = 40;
      const t0 = performance.now();
      for (let i = 0; i < N; i++) comp.drawPlan(p as never, sources);
      (canvas.getContext("2d") as OffscreenCanvasRenderingContext2D).getImageData(0, 0, 1, 1);
      return { msPerFrame: (performance.now() - t0) / N, used: comp.lastChromaBackend };
    };
    return { none: await measure("none"), gpu: await measure("gpu"), cpu: await measure("cpu") };
  });
  console.log("CHROMA 1080p", JSON.stringify(result));
  expect(result.gpu.msPerFrame).toBeGreaterThan(0);
});
