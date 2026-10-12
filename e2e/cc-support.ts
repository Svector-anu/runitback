import type { Page } from "@playwright/test";
import { writeFileSync, mkdirSync } from "node:fs";
import { mediabunnyModuleUrl } from "./media";

export type Rgb = [number, number, number];
export type Point = [number, number];

/** `bands`: red, green, blue, grey quarters. `halves`: dark left half, light right half (a hard vertical edge at x=160). `ramp`: hue advances 6 degrees per frame, so every moment of the clip has its own colour. */
export interface CcClip { color: string; seconds: number; pattern?: "bands" | "halves" | "ramp" }

/** The harness the pages of cc-*.spec.ts talk to; installed by `openCcHarness`. */
export interface CcHarness {
  mods: {
    model: typeof import("../src/engine/model");
    commands: typeof import("../src/engine/commands");
    timeline: typeof import("../src/engine/timeline");
    agent: typeof import("../src/engine/agent");
    time: typeof import("../src/engine/time");
  };
  editor: import("../src/engine/editor").Editor;
  ids: string[];
  renderAt(seconds: number, points: Point[]): Promise<Rgb[]>;
  statsAt(seconds: number): Promise<PixelStats>;
  pngAt(seconds: number): Promise<string>;
  exportAt(input: { times: number[]; points: Point[]; stats?: boolean }): Promise<{ samples: Rgb[][]; durationSeconds: number; frames: number; stats?: PixelStats[] }>;
}

declare global {
  interface Window { __cc: CcHarness }
}

/** Pixel classes over the whole frame: red (r>180, g,b<90), blue, light (all >90), and the mean row of the white pixels. */
export interface PixelStats { red: number; blue: number; white: number; whiteCentroidY: number }

export const ARTIFACT_DIR = "e2e/.artifacts/cc";

export function savePng(name: string, dataUrl: string): void {
  mkdirSync(ARTIFACT_DIR, { recursive: true });
  writeFileSync(`${ARTIFACT_DIR}/${name}.png`, Buffer.from(dataUrl.split(",")[1] ?? "", "base64"));
}

/**
 * Builds a project in the page out of solid-colour WebM clips (real encode, real decode) placed back to back on the
 * main track, and exposes render/export probes that run the shipped frame plan, compositor and exporter.
 */
export async function openCcHarness(page: Page, clips: CcClip[]): Promise<void> {
  await page.goto("/#/projects");
  const mediabunnyUrl = await mediabunnyModuleUrl(page);
  await page.evaluate(async ({ clips, mediabunnyUrl }) => {
    const mb = (await import(/* @vite-ignore */ mediabunnyUrl)) as typeof import("mediabunny");
    const load = <T>(url: string): Promise<T> => import(/* @vite-ignore */ url) as Promise<T>;
    const [model, commands, timeline, agent, time, editorMod, renderMod, compositorMod, sourcesMod, framesMod, exporterMod] = await Promise.all([
      load<typeof import("../src/engine/model")>("/src/engine/model/index.ts"),
      load<typeof import("../src/engine/commands")>("/src/engine/commands/index.ts"),
      load<typeof import("../src/engine/timeline")>("/src/engine/timeline/index.ts"),
      load<typeof import("../src/engine/agent")>("/src/engine/agent/index.ts"),
      load<typeof import("../src/engine/time")>("/src/engine/time/index.ts"),
      load<typeof import("../src/engine/editor")>("/src/engine/editor/index.ts"),
      load<typeof import("../src/engine/render")>("/src/engine/render/index.ts"),
      load<typeof import("../src/render/compositor")>("/src/render/compositor.ts"),
      load<typeof import("../src/platform/frame-sources")>("/src/platform/frame-sources.ts"),
      load<typeof import("../src/platform/video-frames")>("/src/platform/video-frames.ts"),
      load<typeof import("../src/export/exporter")>("/src/export/exporter.ts"),
    ]);

    const W = 320, H = 180;
    async function solidWebm(color: string, seconds: number, pattern?: "bands" | "halves" | "ramp"): Promise<Blob> {
      const canvas = new OffscreenCanvas(W, H);
      const ctx = canvas.getContext("2d") as OffscreenCanvasRenderingContext2D;
      const output = new mb.Output({ format: new mb.WebMOutputFormat(), target: new mb.BufferTarget() });
      const video = new mb.CanvasSource(canvas, { codec: "vp9", bitrate: mb.QUALITY_HIGH });
      output.addVideoTrack(video, { frameRate: 30 });
      await output.start();
      for (let i = 0; i < Math.round(seconds * 30); i++) {
        ctx.fillStyle = pattern === "ramp" ? `hsl(${(i * 6) % 360} 80% 50%)` : color;
        ctx.fillRect(0, 0, W, H);
        if (pattern === "bands") {
          ["#ff0000", "#00ff00", "#0000ff", "#808080"].forEach((c, band) => { ctx.fillStyle = c; ctx.fillRect(band * (W / 4), 0, W / 4, H); });
        } else if (pattern === "halves") {
          ctx.fillStyle = "#404040"; ctx.fillRect(0, 0, W / 2, H);
          ctx.fillStyle = "#c0c0c0"; ctx.fillRect(W / 2, 0, W / 2, H);
        }
        await video.add(i / 30, 1 / 30);
      }
      await output.finalize();
      return new Blob([(output.target as InstanceType<typeof mb.BufferTarget>).buffer as ArrayBuffer], { type: "video/webm" });
    }

    const newId = model.sequentialIds("cc");
    const now = "2026-01-01T00:00:00.000Z";
    const editor = new editorMod.Editor({ newId, now: () => now });
    editor.load({ project: model.createProject({ id: "p", name: "cc", ids: newId, now }), assets: [] });
    const blobs = new Map<string, Blob>();
    const ids: string[] = [];
    let at = 0;
    for (const [i, clip] of clips.entries()) {
      const blob = await solidWebm(clip.color, clip.seconds, clip.pattern);
      const asset = {
        id: `asset-${i}`, name: `clip-${i}.webm`, type: "video" as const, size: blob.size, lastModified: 0,
        width: W, height: H, duration: time.mediaTimeFromSeconds(clip.seconds), fps: { numerator: 30, denominator: 1 }, hasAudio: false,
      };
      blobs.set(asset.id, blob);
      editor.registerAsset(asset);
      const elementId = `clip-${i}`;
      editor.execute(commands.insertMediaElement({ asset, elementId, startTime: at, placement: { mode: "explicit", trackId: editor.tracks().main.id } }));
      ids.push(elementId);
      at += asset.duration;
    }
    const getBlob = (id: string): Blob | undefined => blobs.get(id);

    const canvas = document.createElement("canvas");
    canvas.width = W; canvas.height = H;
    const compositor = new compositorMod.Compositor(canvas);
    const frames = new framesMod.VideoFrameCache(getBlob);
    const sources = new sourcesMod.CachedFrameSources(frames, new sourcesMod.ImageCache(getBlob));
    const renderAt = async (seconds: number, points: Array<[number, number]>): Promise<Array<[number, number, number]>> => {
      const doc = editor.getState().doc;
      const plan = renderMod.buildFramePlan({
        tracks: editor.tracks(), canvas: doc.settings.canvasSize, background: doc.settings.background,
        assets: doc.assets, time: time.mediaTimeFromSeconds(seconds),
      });
      await compositor.render(plan, sources);
      const ctx = canvas.getContext("2d") as CanvasRenderingContext2D;
      return points.map(([x, y]) => { const d = ctx.getImageData(x, y, 1, 1).data; return [d[0] ?? 0, d[1] ?? 0, d[2] ?? 0]; });
    };
    const classify = (data: Uint8ClampedArray): PixelStats => {
      let red = 0, blue = 0, white = 0, rows = 0;
      for (let i = 0; i < data.length; i += 4) {
        const r = data[i] ?? 0, g = data[i + 1] ?? 0, b = data[i + 2] ?? 0;
        if (r > 180 && g < 90 && b < 90) red++;
        else if (b > 180 && r < 90 && g < 90) blue++;
        else if (r > 90 && g > 90 && b > 90) { white++; rows += Math.floor(i / 4 / W); }
      }
      return { red, blue, white, whiteCentroidY: white > 0 ? rows / white : -1 };
    };
    const statsAt = async (seconds: number): Promise<PixelStats> => {
      await renderAt(seconds, [[0, 0]]);
      return classify((canvas.getContext("2d") as CanvasRenderingContext2D).getImageData(0, 0, W, H).data);
    };
    window.__cc = {
      statsAt,
      mods: { model, commands, timeline, agent, time }, editor, ids, renderAt,
      pngAt: async (seconds) => { await renderAt(seconds, [[0, 0]]); return canvas.toDataURL("image/png"); },
      exportAt: async ({ times, points, stats: wantStats }) => {
        const result = await exporterMod.exportProject({
          doc: editor.getState().doc, getBlob, options: { format: "webm", quality: "high", includeAudio: false },
        });
        const input = new mb.Input({ source: new mb.BlobSource(result.blob), formats: mb.ALL_FORMATS });
        const track = await input.getPrimaryVideoTrack();
        const sink = new mb.CanvasSink(track!);
        const samples: Array<Array<[number, number, number]>> = [];
        const stats: PixelStats[] = [];
        for (const t of times) {
          const frame = await sink.getCanvas(t);
          const c = frame!.canvas as HTMLCanvasElement | OffscreenCanvas;
          const ctx = c.getContext("2d") as CanvasRenderingContext2D;
          if (wantStats) stats.push(classify(ctx.getImageData(0, 0, W, H).data));
          samples.push(points.map(([x, y]) => { const d = ctx.getImageData(x, y, 1, 1).data; return [d[0] ?? 0, d[1] ?? 0, d[2] ?? 0]; }));
        }
        return { samples, durationSeconds: result.durationSeconds, frames: result.frameCount, ...(wantStats ? { stats } : {}) };
      },
    };
  }, { clips, mediabunnyUrl });
}

export const near = (actual: Rgb, expected: Rgb, tolerance = 28): boolean => actual.every((v, i) => Math.abs(v - (expected[i] as number)) <= tolerance);

/** Runs an agent tool in the page against the harness editor (the same registry the chat agent uses). */
export async function callAgentTool(page: Page, name: string, args: unknown): Promise<{ ok: boolean; error?: string; data?: unknown }> {
  return page.evaluate(async ({ name, args }) => {
    const { editor, mods } = window.__cc;
    const result = await mods.agent.callTool({ tools: mods.agent.createAgentTools(), name, args, ctx: { editor, nowMs: () => 0 } });
    return result.ok ? { ok: true, data: result.data } : { ok: false, error: `${result.error} ${result.hint ?? ""}` };
  }, { name, args });
}

/** The colour the ramp pattern shows at `seconds` (30 fps, 6 degrees per frame, hsl 80% 50%). */
export function rampColor(seconds: number): Rgb {
  const hue = ((Math.floor(seconds * 30 + 1e-6) * 6) % 360) / 360;
  const s = 0.8, l = 0.5;
  const q = l + s - l * s, p = 2 * l - q;
  const channel = (tIn: number): number => {
    const t = (tIn + 1) % 1;
    const v = t < 1 / 6 ? p + (q - p) * 6 * t : t < 1 / 2 ? q : t < 2 / 3 ? p + (q - p) * (2 / 3 - t) * 6 : p;
    return Math.round(v * 255);
  };
  return [channel(hue + 1 / 3), channel(hue), channel(hue - 1 / 3)];
}
