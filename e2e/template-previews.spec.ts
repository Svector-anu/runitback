import { expect, test } from "@playwright/test";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { mediabunnyModuleUrl } from "./media";

/**
 * Opt-in generator for public/templates/<id>.webp (poster, 640 px wide) and <id>.mp4 (silent loop of the first seconds).
 *
 *   TEMPLATE_PREVIEWS=1 PLAYWRIGHT_PORT=5264 pnpm exec playwright test e2e/template-previews.spec.ts
 *   TEMPLATE_ONLY=listicle,before-after   limit to some templates
 *   TEMPLATE_FRAMES=1                     also write PNG frames every 1.5 s of the whole template for review (to $TEMPLATE_FRAMES_DIR, default e2e/template-frames/)
 *
 * The media is drawn procedurally and encoded for real in the page; the template is applied by the shipped engine and exported
 * by the shipped exporter. The posters come from the shipped compositor. Nothing here is third-party content.
 */
test.skip(process.env["TEMPLATE_PREVIEWS"] !== "1", "set TEMPLATE_PREVIEWS=1 to regenerate the template previews");
test.use({ channel: "chrome" });

const OUT = join(process.cwd(), "public", "templates");
const FRAMES = process.env["TEMPLATE_FRAMES_DIR"] ?? join(process.cwd(), "e2e", "template-frames");
const MAX_VIDEO_BYTES = 400 * 1024;
const MAX_POSTER_BYTES = 60 * 1024;
const POSTER_WIDTH = 640;
const BROWSER = "/e2e/template-browser.ts";
type Browser = typeof import("./template-browser");

/** Ids and preview file names straight from the JSON sources: the spec runs in Node, which cannot import them as modules. */
const TEMPLATES = readdirSync(join(process.cwd(), "src", "templates")).filter((f) => f.endsWith(".json")).sort().map((f) => {
  const raw = JSON.parse(readFileSync(join(process.cwd(), "src", "templates", f), "utf8")) as { id: string; preview?: { poster: string; video: string } };
  return raw;
});

const only = (process.env["TEMPLATE_ONLY"] ?? "").split(",").filter(Boolean);

for (const template of TEMPLATES.filter((t) => only.length === 0 || only.includes(t.id))) {
  test(`preview for ${template.id}`, async ({ page }) => {
    test.setTimeout(600_000);
    mkdirSync(OUT, { recursive: true });
    await page.goto("/#/projects");
    await mediabunnyModuleUrl(page);
    const result = await page.evaluate(async ({ id, url, dumpFrames, maxVideo, posterWidth }) => {
      const mod = (await import(/* @vite-ignore */ url)) as Browser;
      const plan = mod.PREVIEW_PLAN[id];
      if (!plan) throw new Error(`no preview plan for ${id}`);
      const harness = await mod.buildTemplateProject(id);
      const poster = await mod.posterWebp(harness, { seconds: plan.posterAt, width: posterWidth });
      const frames: Array<{ at: number; base64: string }> = [];
      if (dumpFrames) {
        const total = harness.editor.duration() / 120_000;
        for (let at = 0; at < total - 0.2; at += 1.5) frames.push({ at, base64: await mod.framePng(harness, { seconds: at + 0.35, width: 640 }) });
      }
      const video = await mod.previewMp4(harness, { seconds: plan.seconds, maxBytes: maxVideo, longEdge: 480 });
      return { poster, video, frames, warnings: harness.warnings.map((w) => w.message) };
    }, { id: template.id, url: BROWSER, dumpFrames: process.env["TEMPLATE_FRAMES"] === "1", maxVideo: MAX_VIDEO_BYTES - 16 * 1024, posterWidth: POSTER_WIDTH });

    expect(result.warnings, "applying to generated media must not warn").toEqual([]);
    expect(result.poster.bytes).toBeLessThanOrEqual(MAX_POSTER_BYTES);
    expect(result.video.bytes).toBeLessThanOrEqual(MAX_VIDEO_BYTES);
    writeFileSync(join(OUT, template.preview?.poster ?? `${template.id}.webp`), Buffer.from(result.poster.base64, "base64"));
    writeFileSync(join(OUT, template.preview?.video ?? `${template.id}.mp4`), Buffer.from(result.video.base64, "base64"));
    if (result.frames.length > 0) {
      mkdirSync(FRAMES, { recursive: true });
      for (const f of result.frames) writeFileSync(join(FRAMES, `${template.id}-${String(Math.round(f.at * 10)).padStart(3, "0")}.png`), Buffer.from(f.base64, "base64"));
    }
    test.info().annotations.push({ type: "preview", description: `${template.id}: poster ${result.poster.bytes} B (${result.poster.width}x${result.poster.height}), video ${result.video.bytes} B (${result.video.width}x${result.video.height} @ ${result.video.fps} fps, ${result.video.bitrate} bps)` });
    process.stdout.write(`${template.id}: poster ${result.poster.bytes} B, video ${result.video.bytes} B ${result.video.width}x${result.video.height} ${result.video.seconds}s\n`);
  });
}
