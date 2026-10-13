import { expect, test, type Page } from "@playwright/test";
import { callAgentTool, openVfxHarness, type Rgb } from "./vfx-support";

test.use({ channel: "chrome" });
test.setTimeout(240_000);

const W = 320, H = 180;

/** The most followable point near the middle of the clip's first frame, as 0..1 fractions (what a user would click on). */
async function followablePoint(page: Page, clipIndex: number): Promise<{ u: number; v: number }> {
  return page.evaluate(async (index) => {
    const trackingUrl = "/src/engine/tracking/index.ts";
    const { textureScore } = (await import(/* @vite-ignore */ trackingUrl)) as typeof import("../src/engine/tracking");
    const frame = await window.__vfx.textureLuma(index, 0.02);
    let best = { x: 0, y: 0, score: -1 };
    for (let y = 60; y <= 120; y++) for (let x = 100; x <= 220; x++) {
      const score = textureScore(frame, x, y, 10);
      if (score > best.score) best = { x, y, score };
    }
    return { u: best.x / (frame.width - 1), v: best.y / (frame.height - 1) };
  }, clipIndex);
}

/** Centroid of the pixels matching `test` in the rendered preview at `seconds`, or null. */
async function centroid(page: Page, seconds: number, test: string): Promise<{ x: number; y: number; n: number } | null> {
  return page.evaluate(async ({ seconds, test }) => {
    const matches = new Function("r", "g", "b", `return (${test});`) as (r: number, g: number, b: number) => boolean;
    const points: Array<[number, number]> = [];
    // renderAt samples single pixels; render once then read the whole frame through the PNG data URL decode path.
    const url = await window.__vfx.pngAt(seconds);
    const bitmap = await createImageBitmap(await (await fetch(url)).blob());
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext("2d") as OffscreenCanvasRenderingContext2D;
    ctx.drawImage(bitmap, 0, 0);
    const d = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    let sx = 0, sy = 0, n = 0;
    for (let y = 0; y < canvas.height; y++) for (let x = 0; x < canvas.width; x++) {
      const i = 4 * (y * canvas.width + x);
      if (matches(d[i] ?? 0, d[i + 1] ?? 0, d[i + 2] ?? 0)) { sx += x; sy += y; n++; }
    }
    void points;
    return n > 0 ? { x: sx / n, y: sy / n, n } : null;
  }, { seconds, test });
}

const isMagenta = "r > 200 && b > 200 && g < 70";
const isBeacon = "r > 200 && g < 60 && b < 60";

test("track_point: a graphic follows a point of a moving video within 2 px of ground truth (real analyser and worker)", async ({ page }) => {
  await openVfxHarness(page, [{ color: "#000000", seconds: 4, pattern: "texture", motion: "orbit", fps: 30 }]);
  const start = await followablePoint(page, 0);
  const rect = await callAgentTool(page, "insert_graphic", { shape: "rectangle", start: 0, duration: 4, params: { fill: "#ff00ff" }, newTrack: true });
  expect(rect.ok, rect.error).toBe(true);
  const targetId = (rect.data as { elementId: string }).elementId;
  const sized = await callAgentTool(page, "set_params", { elementId: targetId, params: { "transform.scaleX": 0.1, "transform.scaleY": 0.1 } });
  expect(sized.ok, sized.error).toBe(true);

  const startedAt = Date.now();
  const result = await page.evaluate(({ start, targetId }) => window.__vfx.callMotion("track_point", { videoElementId: "clip-0", targetElementId: targetId, x: start.u, y: start.v }), { start, targetId });
  console.log(`TRACK analysis of 121 frames at 320x180: ${Date.now() - startedAt} ms (decode + worker)`);
  expect(result.ok, result.error).toBe(true);
  const data = result.data as { framesTracked: number; lostFrames: number; meanConfidence: number; keyframes: { positionX: number } };
  console.log("TRACK", JSON.stringify(data));
  expect(data.lostFrames).toBe(0);
  expect(data.meanConfidence).toBeGreaterThan(0.9);
  expect(data.keyframes.positionX).toBeLessThan(data.framesTracked);

  const truth = await page.evaluate(() => window.__vfx.truth(0));
  const startPx = { x: start.u * (W - 1), y: start.v * (H - 1) };
  let worst = 0;
  const checks = [0.1, 0.5, 0.9, 1.4, 1.9, 2.5, 3.1, 3.7];
  for (const t of checks) {
    const frame = Math.min(truth.length - 1, Math.round(t * 30));
    const expected = { x: startPx.x + (truth[frame]!.x - truth[0]!.x), y: startPx.y + (truth[frame]!.y - truth[0]!.y) };
    const found = await centroid(page, t, isMagenta);
    expect(found, `graphic visible at ${t}s`).not.toBeNull();
    const error = Math.hypot((found as { x: number }).x - expected.x, (found as { y: number }).y - expected.y);
    worst = Math.max(worst, error);
  }
  console.log("TRACK worst px error", worst.toFixed(2));
  expect(worst).toBeLessThan(2);
});

test("track_point refuses a flat point with a plain explanation and changes nothing", async ({ page }) => {
  await openVfxHarness(page, [{ color: "#336699", seconds: 2 }]);
  const rect = await callAgentTool(page, "insert_graphic", { shape: "rectangle", start: 0, duration: 2, newTrack: true });
  const targetId = (rect.data as { elementId: string }).elementId;
  const result = await page.evaluate((targetId) => window.__vfx.callMotion("track_point", { videoElementId: "clip-0", targetElementId: targetId, x: 0.5, y: 0.5 }), targetId);
  expect(result.ok).toBe(false);
  expect(result.error).toMatch(/texture|detail/);
  const keys = await page.evaluate((id) => Object.keys((window.__vfx.editor.tracks().overlay.flatMap((t) => t.elements as Array<{ id: string; animations?: object }>).find((e) => e.id === id)?.animations) ?? {}), targetId);
  expect(keys).toEqual([]);
});

test("stabilize_clip: shake in the rendered picture drops by at least 70% and the pan survives (real analyser and worker)", async ({ page }) => {
  await openVfxHarness(page, [{ color: "#000000", seconds: 4, pattern: "texture", motion: "shake", fps: 30 }]);
  const times = Array.from({ length: 36 }, (_, i) => 0.2 + i * 0.1);

  const trace = async (): Promise<Array<{ x: number; y: number }>> => {
    const out: Array<{ x: number; y: number }> = [];
    for (const t of times) {
      const c = await centroid(page, t, isBeacon);
      expect(c, `beacon visible at ${t}`).not.toBeNull();
      out.push({ x: (c as { x: number }).x, y: (c as { y: number }).y });
    }
    return out;
  };
  const jitter = (series: number[]): number => {
    const second = series.slice(2).map((v, i) => v - 2 * (series[i + 1] as number) + (series[i] as number));
    return Math.sqrt(second.reduce((s, v) => s + v * v, 0) / second.length);
  };

  const before = await trace();
  const startedAt = Date.now();
  const result = await page.evaluate(() => window.__vfx.callMotion("stabilize_clip", { elementId: "clip-0", smoothness: 0.4 }));
  console.log(`STABILIZE analysis of 121 frames at 320x180: ${Date.now() - startedAt} ms (decode + worker)`);
  expect(result.ok, result.error).toBe(true);
  console.log("STABILIZE", JSON.stringify(result.data));
  const after = await trace();

  const reductionX = 1 - jitter(after.map((p) => p.x)) / jitter(before.map((p) => p.x));
  const reductionY = 1 - jitter(after.map((p) => p.y)) / jitter(before.map((p) => p.y));
  console.log("STABILIZE jitter reduction", reductionX.toFixed(2), reductionY.toFixed(2));
  expect(reductionX).toBeGreaterThan(0.7);
  expect(reductionY).toBeGreaterThan(0.7);
  const panBefore = before[before.length - 1]!.x - before[0]!.x, panAfter = after[after.length - 1]!.x - after[0]!.x;
  expect(panAfter / panBefore).toBeGreaterThan(0.6);
  expect(panAfter / panBefore).toBeLessThan(1.5);

  const state = await page.evaluate(() => {
    const el = window.__vfx.editor.tracks().main.elements[0] as { params: Record<string, number> };
    return { scale: el.params["transform.scaleX"] };
  });
  expect(state.scale).toBeGreaterThan(1);
  expect(state.scale).toBeLessThan(1.3);

  const exported = await page.evaluate(() => window.__vfx.exportAt({ times: [1, 2], points: [[160, 90]] }));
  expect(exported.frames).toBeGreaterThan(100);
  void ({} as Rgb);
});
