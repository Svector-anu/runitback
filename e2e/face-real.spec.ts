import { readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import { expect, test } from "@playwright/test";

/**
 * Opt-in end-to-end check of the REAL face detector: runs the MediaPipe BlazeFace model from the self-hosted
 * `public/mediapipe` assets (no download) through the real worker and the real frame decoder, so it is skipped unless
 * `REAL_FACE=1`. Solid-colour frames must yield no faces. Local videos are read from disk and never copied into the repo:
 * `FACE_PRESENT_VIDEO` is a clip with a visible face on most frames, `FACE_ABSENT_VIDEO` one without real faces.
 */
test.skip(process.env.REAL_FACE !== "1", "set REAL_FACE=1 to run the real MediaPipe face detector");
test.setTimeout(600_000);

const ENTRY_URL = "/evals/browser-entry.ts";
const INDEXER_URL = "/src/platform/visual/face-indexer.ts";
const FRAMES_URL = "/src/platform/visual/frame-source.ts";
const PROBE_URL = "/src/platform/probe.ts";
const MAX_FRAMES = 40;
const SAMPLE_PREVIEWS = 3;

interface Box { x: number; y: number; width: number; height: number; score: number }
interface Measurement {
  model: string;
  sampled: number;
  withFaces: number;
  firstBoxes: Array<{ t: number; boxes: Box[] }>;
  previews: Array<{ t: number; png: string }>;
}

interface Source { name: string; base64: string | null }

async function measure(page: import("@playwright/test").Page, source: Source): Promise<Measurement> {
  return page.evaluate(async ({ entryUrl, indexerUrl, framesUrl, probeUrl, maxFrames, previewCount, source: input }): Promise<Measurement> => {
    const entry = (await import(/* @vite-ignore */ entryUrl)) as typeof import("../evals/browser-entry");
    const { createFaceIndexer } = (await import(/* @vite-ignore */ indexerUrl)) as typeof import("../src/platform/visual/face-indexer");
    const { openVideoFrames } = (await import(/* @vite-ignore */ framesUrl)) as typeof import("../src/platform/visual/frame-source");
    const { probeMedia } = (await import(/* @vite-ignore */ probeUrl)) as typeof import("../src/platform/probe");
    const file = input.base64
      ? new File([Uint8Array.from(atob(input.base64), (char) => char.charCodeAt(0))], input.name, { type: "video/mp4" })
      : await entry.generateFixtureFile({ id: "colors", name: "colors.webm", kind: "video", durationSeconds: 6, audio: { kind: "none" }, blocks: [{ seconds: 3, rgb: [220, 30, 30] }, { seconds: 3, rgb: [30, 60, 230] }] });
    const durationSeconds = ((await probeMedia(file, input.name)).duration ?? 0) / 120_000;
    const indexer = createFaceIndexer({ getVideo: () => file, getFootage: async () => ({ durationSeconds, cutTimes: [] }), maxFrames });
    const detections = await indexer.index({ assetId: input.name });

    const hits = detections.frames.filter((f) => f.boxes.length > 0);
    const shown = (hits.length > 0 ? hits : detections.frames).slice(0, previewCount);
    const frames = openVideoFrames(file);
    const previews: Measurement["previews"] = [];
    for (const frame of shown) {
      const pixels = await frames.frameAt(frame.t);
      if (!pixels) continue;
      const canvas = new OffscreenCanvas(pixels.width, pixels.height);
      const ctx = canvas.getContext("2d") as OffscreenCanvasRenderingContext2D;
      ctx.putImageData(new ImageData(new Uint8ClampedArray(pixels.data), pixels.width, pixels.height), 0, 0);
      ctx.strokeStyle = "#00ff00";
      ctx.lineWidth = 2;
      for (const b of frame.boxes) ctx.strokeRect(b.x * pixels.width, b.y * pixels.height, b.width * pixels.width, b.height * pixels.height);
      const blob = await canvas.convertToBlob({ type: "image/png" });
      const buffer = new Uint8Array(await blob.arrayBuffer());
      previews.push({ t: frame.t, png: btoa(Array.from(buffer, (byte) => String.fromCharCode(byte)).join("")) });
    }
    await frames.dispose();
    return {
      model: detections.model, sampled: detections.frames.length, withFaces: hits.length,
      firstBoxes: shown.map((f) => ({ t: f.t, boxes: f.boxes })), previews,
    };
  }, { entryUrl: ENTRY_URL, indexerUrl: INDEXER_URL, framesUrl: FRAMES_URL, probeUrl: PROBE_URL, maxFrames: MAX_FRAMES, previewCount: SAMPLE_PREVIEWS, source });
}

function report(label: string, result: Measurement, outputPath: (name: string) => string): void {
  result.previews.forEach((preview, i) => writeFileSync(outputPath(`${label}-${i}.png`), Buffer.from(preview.png, "base64")));
  console.log(`${label}: ${result.withFaces}/${result.sampled} frames with faces`, JSON.stringify(result.firstBoxes));
}

const localVideo = (variable: string): Source | null => {
  const path = process.env[variable];
  return path ? { name: basename(path), base64: readFileSync(path).toString("base64") } : null;
};

test("solid-colour frames contain no faces", async ({ page }, testInfo) => {
  await page.goto("/");
  const result = await measure(page, { name: "colors.webm", base64: null });
  report("solid", result, (name) => testInfo.outputPath(name));
  expect(result.model).toBe("mediapipe/blaze_face_short_range");
  expect(result.sampled).toBeGreaterThan(0);
  expect(result.withFaces).toBe(0);
});

test("a clip with a visible face is detected on most frames, with plausible boxes", async ({ page }, testInfo) => {
  const source = localVideo("FACE_PRESENT_VIDEO");
  test.skip(!source, "set FACE_PRESENT_VIDEO to a local video with a visible face");
  await page.goto("/");
  const result = await measure(page, source as Source);
  report("present", result, (name) => testInfo.outputPath(name));
  expect(result.withFaces / result.sampled).toBeGreaterThan(0.5);
  for (const { boxes } of result.firstBoxes) for (const b of boxes) {
    expect(b.score).toBeGreaterThan(0.5);
    expect(b.x).toBeGreaterThanOrEqual(0);
    expect(b.x + b.width).toBeLessThanOrEqual(1.0001);
    expect(b.width * b.height).toBeLessThan(0.8);
  }
});

test("a clip without real faces is not reported as having faces", async ({ page }, testInfo) => {
  const source = localVideo("FACE_ABSENT_VIDEO");
  test.skip(!source, "set FACE_ABSENT_VIDEO to a local video without faces");
  await page.goto("/");
  const result = await measure(page, source as Source);
  report("absent", result, (name) => testInfo.outputPath(name));
  expect(result.withFaces / result.sampled).toBeLessThan(0.1);
});
