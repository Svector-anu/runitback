import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { importGenerated, mediabunnyModuleUrl } from "./media";

test.use({ channel: "chrome" });
test.setTimeout(300_000);

/**
 * Real MediaPipe Selfie Segmenter (self-hosted under public/mediapipe, no download) on MediaPipe's own public
 * `portrait.jpg` test image: the person must stay opaque and the curtains, flags and desk must become transparent,
 * in the preview and in a decoded export. The image is not committed: PORTRAIT_IMAGE, e2e/.fixtures/portrait.jpg, or a
 * download from storage.googleapis.com/mediapipe-assets/portrait.jpg (the spec skips when none is available).
 */
const PORTRAIT_URL = "https://storage.googleapis.com/mediapipe-assets/portrait.jpg";
const CACHE = "e2e/.fixtures/portrait.jpg";

async function portraitBytes(): Promise<Buffer | null> {
  const explicit = process.env.PORTRAIT_IMAGE;
  if (explicit && existsSync(explicit)) return readFileSync(explicit);
  if (existsSync(CACHE)) return readFileSync(CACHE);
  try {
    const response = await fetch(PORTRAIT_URL);
    if (!response.ok) return null;
    const bytes = Buffer.from(await response.arrayBuffer());
    mkdirSync("e2e/.fixtures", { recursive: true });
    writeFileSync(CACHE, bytes);
    return bytes;
  } catch {
    return null;
  }
}

/** Fractions of the 820x1024 picture: where the person certainly is, and where the room certainly is. */
const PERSON: Array<[number, number]> = [[0.5, 0.62], [0.5, 0.2], [0.35, 0.7], [0.62, 0.55]];
const ROOM: Array<[number, number]> = [[0.04, 0.1], [0.96, 0.08], [0.96, 0.4], [0.04, 0.45], [0.5, 0.01]];

let bytes: Buffer | null = null;
test.beforeAll(async () => { bytes = await portraitBytes(); });

async function importPortrait(page: Page): Promise<void> {
  await page.goto("/#/projects");
  await page.getByRole("button", { name: /New project|Create your first project/ }).first().click();
  await expect(page.getByLabel("Project name")).toBeVisible();
  await page.evaluate((b64) => {
    const data = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    (window as unknown as { __files: File[] }).__files = [new File([data], "portrait.jpg", { type: "image/jpeg" })];
  }, (bytes as Buffer).toString("base64"));
  await importGenerated(page);
  const add = page.getByRole("button", { name: "Add portrait.jpg to timeline" });
  await expect(add).toBeVisible({ timeout: 30_000 });
  await add.click({ force: true });
  await expect(page.locator("[data-clip-id]")).toHaveCount(1);
}

const previewAt = (page: Page, points: Array<[number, number]>): Promise<Array<[number, number, number]>> =>
  page.evaluate((pts) => {
    const canvas = document.querySelector<HTMLCanvasElement>(".preview__scene canvas") as HTMLCanvasElement;
    const ctx = canvas.getContext("2d") as CanvasRenderingContext2D;
    return pts.map(([fx, fy]) => {
      const d = ctx.getImageData(Math.floor(fx * (canvas.width - 1)), Math.floor(fy * (canvas.height - 1)), 1, 1).data;
      return [d[0] ?? 0, d[1] ?? 0, d[2] ?? 0] as [number, number, number];
    });
  }, points);

const isMagenta = (c: [number, number, number]): boolean => c[0] > 200 && c[1] < 60 && c[2] > 200;

test("real model on portrait.jpg: person stays, room goes (preview and decoded export), and the status/undo behave", async ({ page }, testInfo) => {
  test.skip(!bytes, "portrait.jpg is not available (offline and not cached)");
  await importPortrait(page);

  await page.evaluate(async () => {
    const url = "/src/app/services.ts";
    const { getServices } = (await import(/* @vite-ignore */ url)) as typeof import("../src/app/services");
    const commandsUrl = "/src/engine/commands/index.ts";
    const commands = (await import(/* @vite-ignore */ commandsUrl)) as typeof import("../src/engine/commands");
    getServices().editor.execute(commands.updateSettings({ background: { type: "color", color: "#ff00ff" } }));
  });
  const before = await previewAt(page, [...PERSON, ...ROOM]);
  expect(before.some(isMagenta), "nothing is transparent before the effect").toBe(false);

  await page.locator("[data-clip-id]").first().click();
  await page.getByRole("tablist", { name: "Property tabs" }).getByRole("tab", { name: "Effects", exact: true }).click();
  await page.getByRole("button", { name: "Add effect" }).click();
  await page.getByRole("menuitem", { name: "Remove background" }).click();

  const status = page.getByTestId("bg-removal-status");
  await expect(status).toBeVisible();
  const started = Date.now();
  await expect(status).toHaveAttribute("data-state", "ready", { timeout: 120_000 });
  console.log(`BG analysis of a still: ${Date.now() - started} ms (includes model download from disk, wasm init)`);

  await expect.poll(async () => (await previewAt(page, ROOM)).filter(isMagenta).length, { timeout: 15_000 }).toBeGreaterThanOrEqual(4);
  const after = await previewAt(page, [...PERSON, ...ROOM]);
  const person = after.slice(0, PERSON.length), room = after.slice(PERSON.length);
  console.log("person px", JSON.stringify(person), "room px", JSON.stringify(room));
  expect(person.every((c) => !isMagenta(c)), "person pixels keep the photo").toBe(true);
  expect(room.filter(isMagenta).length).toBeGreaterThanOrEqual(4);
  await page.locator(".preview__scene canvas").screenshot({ path: testInfo.outputPath("bg-removed.png") });
  await page.locator(".preview__scene canvas").screenshot({ path: "e2e/.artifacts/vfx/bg-removed-preview.png" }).catch(() => undefined);

  const exported = await page.evaluate(async ({ points }) => {
    const load = <T>(url: string): Promise<T> => import(/* @vite-ignore */ url) as Promise<T>;
    const { getServices } = await load<typeof import("../src/app/services")>("/src/app/services.ts");
    const { exportProject } = await load<typeof import("../src/export/exporter")>("/src/export/exporter.ts");
    const mb = await load<typeof import("mediabunny")>("/node_modules/.vite/deps/mediabunny.js").catch(() => null);
    void mb;
    const services = getServices();
    const result = await exportProject({ doc: services.editor.getState().doc, getBlob: services.runtime.getBlob, options: { format: "webm", quality: "high", includeAudio: false } });
    const { Input, BlobSource, ALL_FORMATS, CanvasSink } = await load<typeof import("mediabunny")>("/@id/mediabunny");
    const input = new Input({ source: new BlobSource(result.blob), formats: ALL_FORMATS });
    const track = await input.getPrimaryVideoTrack();
    const frame = await new CanvasSink(track as NonNullable<typeof track>).getCanvas(0.5);
    const canvas = frame?.canvas as OffscreenCanvas | HTMLCanvasElement;
    const ctx = canvas.getContext("2d") as CanvasRenderingContext2D;
    return points.map(([fx, fy]) => { const d = ctx.getImageData(Math.floor(fx * (canvas.width - 1)), Math.floor(fy * (canvas.height - 1)), 1, 1).data; return [d[0] ?? 0, d[1] ?? 0, d[2] ?? 0] as [number, number, number]; });
  }, { points: [...PERSON, ...ROOM] });
  const exportedPerson = exported.slice(0, PERSON.length), exportedRoom = exported.slice(PERSON.length);
  console.log("export person", JSON.stringify(exportedPerson), "export room", JSON.stringify(exportedRoom));
  const nearMagenta = (c: [number, number, number]): boolean => c[0] > 170 && c[1] < 90 && c[2] > 170;
  expect(exportedRoom.filter(nearMagenta).length).toBeGreaterThanOrEqual(4);
  expect(exportedPerson.every((c) => !nearMagenta(c))).toBe(true);

  await page.getByRole("button", { name: "Disable effect" }).click();
  await expect.poll(async () => (await previewAt(page, ROOM)).filter(isMagenta).length).toBe(0);
});

test("real model speed: ms per frame on a landscape and a portrait frame", async ({ page }) => {
  test.skip(!bytes, "portrait.jpg is not available (offline and not cached)");
  await page.goto("/#/projects");
  const timing = await page.evaluate(async (b64) => {
    const load = <T>(url: string): Promise<T> => import(/* @vite-ignore */ url) as Promise<T>;
    const { createSegmentWorkerBackend } = await load<typeof import("../src/platform/segmentation/worker-backend")>("/src/platform/segmentation/worker-backend.ts");
    const bitmap = await createImageBitmap(new Blob([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))], { type: "image/jpeg" }));
    const pixelsAt = (w: number, h: number) => {
      const canvas = new OffscreenCanvas(w, h);
      const ctx = canvas.getContext("2d") as OffscreenCanvasRenderingContext2D;
      ctx.drawImage(bitmap, 0, 0, w, h);
      return ctx.getImageData(0, 0, w, h);
    };
    const run = async (model: "selfie_segmenter" | "selfie_segmenter_landscape", w: number, h: number): Promise<{ w: number; h: number; msPerFrame: number }> => {
      const backend = createSegmentWorkerBackend();
      const make = (n: number) => Array.from({ length: n }, (_, i) => { const d = pixelsAt(w, h); return { time: i, pixels: { width: w, height: h, data: d.data } }; });
      await backend.segment({ model, frames: make(2) });
      const frames = make(24);
      const t0 = performance.now();
      await backend.segment({ model, frames });
      const ms = (performance.now() - t0) / frames.length;
      backend.dispose();
      return { w, h, msPerFrame: ms };
    };
    return { landscape384x216: await run("selfie_segmenter_landscape", 384, 216), portrait288x384: await run("selfie_segmenter", 288, 384) };
  }, (bytes as Buffer).toString("base64"));
  console.log("SEGMENT ms/frame", JSON.stringify(timing));
  expect(timing.landscape384x216.msPerFrame).toBeGreaterThan(0);
});

test("real model on a VIDEO clip: person stays and the room goes at several moments, in the preview and in a decoded export", async ({ page }) => {
  test.skip(!bytes, "portrait.jpg is not available (offline and not cached)");
  await page.goto("/#/projects");
  await page.getByRole("button", { name: /New project|Create your first project/ }).first().click();
  await expect(page.getByLabel("Project name")).toBeVisible();
  const mediabunny = await mediabunnyModuleUrl(page);
  await page.evaluate(async ({ b64, url }) => {
    const mb = (await import(/* @vite-ignore */ url)) as typeof import("mediabunny");
    const photo = await createImageBitmap(new Blob([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))], { type: "image/jpeg" }));
    const W = 640, H = 360, FPS = 24;
    const canvas = new OffscreenCanvas(W, H);
    const ctx = canvas.getContext("2d") as OffscreenCanvasRenderingContext2D;
    const output = new mb.Output({ format: new mb.WebMOutputFormat(), target: new mb.BufferTarget() });
    const video = new mb.CanvasSource(canvas, { codec: "vp9", bitrate: 8_000_000 });
    output.addVideoTrack(video, { frameRate: FPS });
    await output.start();
    const width = (photo.width / photo.height) * H;
    for (let i = 0; i < 2 * FPS; i++) {
      ctx.fillStyle = "#808080"; ctx.fillRect(0, 0, W, H);
      ctx.drawImage(photo, (W - width) / 2 + 20 * Math.sin(i / 8), 0, width, H);
      await video.add(i / FPS, 1 / FPS);
    }
    await output.finalize();
    (window as unknown as { __files: File[] }).__files = [new File([(output.target as InstanceType<typeof mb.BufferTarget>).buffer as ArrayBuffer], "person.webm", { type: "video/webm" })];
  }, { b64: (bytes as Buffer).toString("base64"), url: mediabunny });
  await importGenerated(page);
  const add = page.getByRole("button", { name: "Add person.webm to timeline" });
  await expect(add).toBeVisible({ timeout: 30_000 });
  await add.click({ force: true });
  await expect(page.locator("[data-clip-id]")).toHaveCount(1);
  await page.evaluate(async () => {
    const load = <T>(url: string): Promise<T> => import(/* @vite-ignore */ url) as Promise<T>;
    const { getServices } = await load<typeof import("../src/app/services")>("/src/app/services.ts");
    const commands = await load<typeof import("../src/engine/commands")>("/src/engine/commands/index.ts");
    getServices().editor.execute(commands.updateSettings({ background: { type: "color", color: "#ff00ff" } }));
  });
  await page.locator("[data-clip-id]").first().click();
  await page.getByRole("tablist", { name: "Property tabs" }).getByRole("tab", { name: "Effects", exact: true }).click();
  await page.getByRole("button", { name: "Add effect" }).click();
  await page.getByRole("menuitem", { name: "Remove background" }).click();
  const started = Date.now();
  await expect(page.getByTestId("bg-removal-status")).toHaveAttribute("data-state", "ready", { timeout: 120_000 });
  console.log(`BG analysis of a 2 s 24 fps video: ${Date.now() - started} ms`);

  const personPts: Array<[number, number]> = [[0.5, 0.62], [0.5, 0.2]];
  const roomPts: Array<[number, number]> = [[0.05, 0.5], [0.95, 0.5], [0.293, 0.1], [0.706, 0.08]];
  const seek = (seconds: number): Promise<void> => page.evaluate(async (s) => {
    const servicesUrl = "/src/app/services.ts";
    const { getServices } = (await import(/* @vite-ignore */ servicesUrl)) as typeof import("../src/app/services");
    getServices().editor.playback.seek(Math.round(s * 120_000));
  }, seconds);
  for (const t of [0.2, 0.9, 1.7]) {
    await seek(t);
    await expect.poll(async () => (await previewAt(page, roomPts)).filter(isMagenta).length, { timeout: 15_000, message: `room at ${t}s` }).toBe(4);
    expect((await previewAt(page, personPts)).every((c) => !isMagenta(c)), `person at ${t}s`).toBe(true);
  }
  const exported = await page.evaluate(async ({ points }) => {
    const load = <T>(url: string): Promise<T> => import(/* @vite-ignore */ url) as Promise<T>;
    const { getServices } = await load<typeof import("../src/app/services")>("/src/app/services.ts");
    const { exportProject } = await load<typeof import("../src/export/exporter")>("/src/export/exporter.ts");
    const mb = await load<typeof import("mediabunny")>("/@id/mediabunny");
    const services = getServices();
    const result = await exportProject({ doc: services.editor.getState().doc, getBlob: services.runtime.getBlob, options: { format: "webm", quality: "high", includeAudio: false } });
    const input = new mb.Input({ source: new mb.BlobSource(result.blob), formats: mb.ALL_FORMATS });
    const sink = new mb.CanvasSink((await input.getPrimaryVideoTrack()) as NonNullable<Awaited<ReturnType<typeof input.getPrimaryVideoTrack>>>);
    const out: Array<Array<[number, number, number]>> = [];
    for (const t of [0.5, 1.5]) {
      const c = (await sink.getCanvas(t))?.canvas as OffscreenCanvas;
      const ctx = c.getContext("2d") as OffscreenCanvasRenderingContext2D;
      out.push(points.map(([fx, fy]) => { const d = ctx.getImageData(Math.floor(fx * (c.width - 1)), Math.floor(fy * (c.height - 1)), 1, 1).data; return [d[0] ?? 0, d[1] ?? 0, d[2] ?? 0] as [number, number, number]; }));
    }
    return out;
  }, { points: [...personPts, ...roomPts] });
  const nearMagenta = (c: [number, number, number]): boolean => c[0] > 170 && c[1] < 90 && c[2] > 170;
  for (const frame of exported) {
    expect(frame.slice(2).filter(nearMagenta).length).toBe(4);
    expect(frame.slice(0, 2).every((c) => !nearMagenta(c))).toBe(true);
  }
});
