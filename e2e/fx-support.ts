import type { Page } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";

export type Rgb = [number, number, number];
export type Point = [number, number];

/** A flat image asset the harness draws itself: a base colour with an optional second colour as a left/right split or a band. */
export interface FxImage { id: string; color: string; width?: number; height?: number; pattern?: "solid" | "halves" | "grid" }

export interface FxHarness {
  mods: {
    model: typeof import("../src/engine/model");
    commands: typeof import("../src/engine/commands");
    timeline: typeof import("../src/engine/timeline");
    agent: typeof import("../src/engine/agent");
    time: typeof import("../src/engine/time");
    templates: typeof import("../src/engine/templates");
  };
  editor: import("../src/engine/editor").Editor;
  /** Renders the frame at `seconds` with the shipped frame plan and compositor. */
  pngAt(seconds: number): Promise<string>;
  pixelsAt(seconds: number, points: Point[]): Promise<Rgb[]>;
  /** Mean colour of a rectangle (x, y, w, h) of the frame at `seconds`. */
  meanAt(seconds: number, rect: [number, number, number, number]): Promise<Rgb>;
  /** Exports the project with the shipped exporter and returns the pixels at `points` of the decoded frames at `times`. */
  exportPixels(input: { times: number[]; points: Point[] }): Promise<Rgb[][]>;
}

declare global {
  interface Window { __fx: FxHarness }
}

export const ARTIFACT_DIR = "e2e/.artifacts/fx";

export function savePng(name: string, dataUrl: string): void {
  mkdirSync(ARTIFACT_DIR, { recursive: true });
  writeFileSync(`${ARTIFACT_DIR}/${name}.png`, Buffer.from(dataUrl.split(",")[1] ?? "", "base64"));
}

export const near = (actual: Rgb, expected: Rgb, tolerance = 28): boolean => actual.every((v, i) => Math.abs(v - (expected[i] as number)) <= tolerance);

/**
 * An empty project in the page plus probes that run the shipped plan, compositor and exporter. `images` become image assets
 * (real PNG encode, real decode); place them with `window.__fx.mods.commands.insertMediaElement`.
 */
export async function openFxHarness(page: Page, images: FxImage[] = []): Promise<void> {
  await page.goto("/#/projects");
  const { mediabunnyModuleUrl } = await import("./media");
  const mediabunnyUrl = await mediabunnyModuleUrl(page);
  await page.evaluate(async ({ images, mediabunnyUrl }) => {
    const mb = (await import(/* @vite-ignore */ mediabunnyUrl)) as typeof import("mediabunny");
    const load = <T>(url: string): Promise<T> => import(/* @vite-ignore */ url) as Promise<T>;
    const [model, commands, timeline, agent, time, templates, editorMod, renderMod, compositorMod, sourcesMod, framesMod, exporterMod] = await Promise.all([
      load<typeof import("../src/engine/model")>("/src/engine/model/index.ts"),
      load<typeof import("../src/engine/commands")>("/src/engine/commands/index.ts"),
      load<typeof import("../src/engine/timeline")>("/src/engine/timeline/index.ts"),
      load<typeof import("../src/engine/agent")>("/src/engine/agent/index.ts"),
      load<typeof import("../src/engine/time")>("/src/engine/time/index.ts"),
      load<typeof import("../src/engine/templates")>("/src/engine/templates/index.ts"),
      load<typeof import("../src/engine/editor")>("/src/engine/editor/index.ts"),
      load<typeof import("../src/engine/render")>("/src/engine/render/index.ts"),
      load<typeof import("../src/render/compositor")>("/src/render/compositor.ts"),
      load<typeof import("../src/platform/frame-sources")>("/src/platform/frame-sources.ts"),
      load<typeof import("../src/platform/video-frames")>("/src/platform/video-frames.ts"),
      load<typeof import("../src/export/exporter")>("/src/export/exporter.ts"),
    ]);

    const newId = model.sequentialIds("fx");
    const now = "2026-01-01T00:00:00.000Z";
    const editor = new editorMod.Editor({ newId, now: () => now });
    editor.load({ project: model.createProject({ id: "p", name: "fx", ids: newId, now }), assets: [] });

    const blobs = new Map<string, Blob>();
    for (const image of images) {
      const width = image.width ?? 960, height = image.height ?? 540;
      const canvas = new OffscreenCanvas(width, height);
      const ctx = canvas.getContext("2d") as OffscreenCanvasRenderingContext2D;
      ctx.fillStyle = image.color;
      ctx.fillRect(0, 0, width, height);
      if (image.pattern === "halves") {
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(width / 2, 0, width / 2, height);
      } else if (image.pattern === "grid") {
        ctx.strokeStyle = "#ffffff";
        ctx.lineWidth = 4;
        for (let x = 0; x <= width; x += width / 8) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, height); ctx.stroke(); }
        for (let y = 0; y <= height; y += height / 4.5) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(width, y); ctx.stroke(); }
      }
      const blob = await canvas.convertToBlob({ type: "image/png" });
      blobs.set(image.id, blob);
      editor.registerAsset({ id: image.id, name: `${image.id}.png`, type: "image", size: blob.size, lastModified: 0, width, height });
    }
    const getBlob = (id: string): Blob | undefined => blobs.get(id);

    const { width: W, height: H } = editor.getState().doc.settings.canvasSize;
    const canvas = document.createElement("canvas");
    canvas.width = W; canvas.height = H;
    const compositor = new compositorMod.Compositor(canvas);
    const frames = new framesMod.VideoFrameCache(getBlob);
    const sources = new sourcesMod.CachedFrameSources(frames, new sourcesMod.ImageCache(getBlob));
    const draw = async (seconds: number): Promise<CanvasRenderingContext2D> => {
      const doc = editor.getState().doc;
      const plan = renderMod.buildFramePlan({ tracks: editor.tracks(), canvas: doc.settings.canvasSize, background: doc.settings.background, assets: doc.assets, time: time.mediaTimeFromSeconds(seconds) });
      await compositor.render(plan, sources);
      return canvas.getContext("2d") as CanvasRenderingContext2D;
    };
    const read = (ctx: CanvasRenderingContext2D, x: number, y: number): [number, number, number] => {
      const d = ctx.getImageData(x, y, 1, 1).data;
      return [d[0] ?? 0, d[1] ?? 0, d[2] ?? 0];
    };
    window.__fx = {
      mods: { model, commands, timeline, agent, time, templates }, editor,
      pngAt: async (seconds) => { await draw(seconds); return canvas.toDataURL("image/png"); },
      pixelsAt: async (seconds, points) => { const ctx = await draw(seconds); return points.map(([x, y]) => read(ctx, x, y)); },
      meanAt: async (seconds, [x, y, w, h]) => {
        const ctx = await draw(seconds);
        const data = ctx.getImageData(x, y, w, h).data;
        let r = 0, g = 0, b = 0;
        for (let i = 0; i < data.length; i += 4) { r += data[i] ?? 0; g += data[i + 1] ?? 0; b += data[i + 2] ?? 0; }
        const n = data.length / 4;
        return [Math.round(r / n), Math.round(g / n), Math.round(b / n)];
      },
      exportPixels: async ({ times, points }) => {
        const result = await exporterMod.exportProject({ doc: editor.getState().doc, getBlob, options: { format: "webm", quality: "high", includeAudio: false } });
        const input = new mb.Input({ source: new mb.BlobSource(result.blob), formats: mb.ALL_FORMATS });
        const track = await input.getPrimaryVideoTrack();
        const sink = new mb.CanvasSink(track!);
        const out: Array<Array<[number, number, number]>> = [];
        for (const t of times) {
          const frame = await sink.getCanvas(t);
          const ctx = (frame!.canvas as HTMLCanvasElement | OffscreenCanvas).getContext("2d") as CanvasRenderingContext2D;
          out.push(points.map(([x, y]) => read(ctx, x, y)));
        }
        return out;
      },
    };
  }, { images, mediabunnyUrl });
}

/** Runs an agent tool in the page against the harness editor (the registry the chat agent uses). */
export async function callAgentTool(page: Page, name: string, args: unknown): Promise<{ ok: boolean; error?: string; data?: unknown }> {
  return page.evaluate(async ({ name, args }) => {
    const { editor, mods } = window.__fx;
    const result = await mods.agent.callTool({ tools: mods.agent.createAgentTools(), name, args, ctx: { editor, nowMs: () => 0 } });
    return result.ok ? { ok: true, data: result.data } : { ok: false, error: `${result.error} ${result.hint ?? ""}` };
  }, { name, args });
}
