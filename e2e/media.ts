import type { Page } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readFile } from "node:fs/promises";

const MEDIABUNNY_ROUTE_PREFIX = "/__e2e-mediabunny__/";
const routedPages = new WeakSet<Page>();
let mediabunnyDistDir: string | undefined;

async function resolveMediabunnyDistDir(): Promise<string> {
  if (!mediabunnyDistDir) {
    // `mediabunny`'s package.json "exports" map points both its "node" and "browser" conditions'
    // `import` entry at the same file (`dist/modules/src/index.js`); resolving through the ESM
    // resolver (rather than `require.resolve`, which would take the "require" condition's
    // bundled-CJS entry instead) is what guarantees we land on that real, unbundled ESM tree.
    const indexUrl = await import.meta.resolve("mediabunny");
    mediabunnyDistDir = dirname(dirname(fileURLToPath(indexUrl)));
  }
  return mediabunnyDistDir;
}

/**
 * Serves mediabunny's real ESM source straight from `node_modules` through Playwright route
 * interception, so the page can import it the same way whether it's served by `vite dev` (which
 * pre-bundles it at a dev-only `/node_modules/.vite/deps/` path) or `vite preview` (which serves
 * the static `dist/` build and has no such path at all). Every internal mediabunny import is a
 * plain relative specifier, so mirroring its `dist/modules` directory tree under one route prefix
 * is enough — except `src/node.js`, which unconditionally does `export * as fs from "node:fs/promises"`;
 * mediabunny's own `package.json` "browser" field maps that file to nothing for bundler builds, and
 * since nothing here bundles it, that substitution is replicated by hand below.
 */
async function ensureMediabunnyRoute(page: Page): Promise<void> {
  if (routedPages.has(page)) return;
  routedPages.add(page);
  const distDir = await resolveMediabunnyDistDir();
  await page.route(`**${MEDIABUNNY_ROUTE_PREFIX}**`, async (route) => {
    const path = new URL(route.request().url()).pathname.split(MEDIABUNNY_ROUTE_PREFIX)[1] ?? "";
    if (path === "src/node.js") {
      await route.fulfill({ contentType: "text/javascript", body: "export {};" });
      return;
    }
    try {
      const body = await readFile(join(distDir, path), "utf-8");
      await route.fulfill({ contentType: "text/javascript", body });
    } catch {
      await route.fulfill({ status: 404, body: `mediabunny fixture file not found: ${path}` });
    }
  });
}

/** Resolves a URL the page can `import()` to get mediabunny, working under both `vite dev` and `vite preview`. */
export async function mediabunnyModuleUrl(page: Page): Promise<string> {
  await ensureMediabunnyRoute(page);
  return `${MEDIABUNNY_ROUTE_PREFIX}src/index.js`;
}

/** Builds a real WebM (VP9 video + Opus tone) inside the page with the same encoder stack the app exports with. */
export async function makeWebm(page: Page, input: { seconds: number; hue: number; name: string; withAudio?: boolean }): Promise<void> {
  const url = await mediabunnyModuleUrl(page);
  await page.evaluate(async ({ seconds, hue, name, withAudio, url }) => {
    const { Output, WebMOutputFormat, BufferTarget, CanvasSource, AudioBufferSource, QUALITY_MEDIUM } = (await import(url)) as typeof import("mediabunny");
    const canvas = new OffscreenCanvas(320, 180);
    const ctx = canvas.getContext("2d") as OffscreenCanvasRenderingContext2D;
    const output = new Output({ format: new WebMOutputFormat(), target: new BufferTarget() });
    const video = new CanvasSource(canvas, { codec: "vp9", bitrate: QUALITY_MEDIUM });
    output.addVideoTrack(video, { frameRate: 30 });
    let audio: InstanceType<typeof AudioBufferSource> | null = null;
    if (withAudio) {
      audio = new AudioBufferSource({ codec: "opus", bitrate: 64000 });
      output.addAudioTrack(audio);
    }
    await output.start();
    if (audio) {
      const rate = 48000;
      const ac = new AudioContext({ sampleRate: rate });
      const buf = ac.createBuffer(1, rate * seconds, rate);
      const data = buf.getChannelData(0);
      for (let i = 0; i < data.length; i++) data[i] = Math.sin((2 * Math.PI * 440 * i) / rate) * 0.3;
      await audio.add(buf);
      audio.close();
    }
    const frames = Math.round(seconds * 30);
    for (let i = 0; i < frames; i++) {
      ctx.fillStyle = `hsl(${(hue + i * 3) % 360} 80% 50%)`;
      ctx.fillRect(0, 0, 320, 180);
      ctx.fillStyle = "#fff";
      ctx.fillRect((i / frames) * 280, 70, 40, 40);
      await video.add(i / 30, 1 / 30);
    }
    await output.finalize();
    const file = new File([(output.target as InstanceType<typeof BufferTarget>).buffer as ArrayBuffer], name, { type: "video/webm" });
    (window as unknown as { __files?: File[] }).__files = [...((window as unknown as { __files?: File[] }).__files ?? []), file];
  }, { ...input, url });
}

/** Feeds files created by makeWebm into the media import input. */
export async function importGenerated(page: Page): Promise<void> {
  await page.waitForSelector('input[aria-label="Import media files"]', { state: "attached", timeout: 20_000 });
  await page.evaluate(() => {
    const input = document.querySelector<HTMLInputElement>('input[aria-label="Import media files"]');
    if (!input) throw new Error("import input not found");
    const dt = new DataTransfer();
    for (const f of (window as unknown as { __files: File[] }).__files) dt.items.add(f);
    (window as unknown as { __files: File[] }).__files = [];
    input.files = dt.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
}
