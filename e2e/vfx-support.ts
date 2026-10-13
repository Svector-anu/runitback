import type { Page } from "@playwright/test";
import { writeFileSync, mkdirSync } from "node:fs";
import { mediabunnyModuleUrl } from "./media";

export type Rgb = [number, number, number];
export type Point = [number, number];

/** `greenscreen`: #00ff00 with a red subject (x 110..210, y 40..140) and a skin-tone patch. `frameid`: the frame index as 10 black/white blocks (see decodeFrameId). `bands`: red, green, blue, grey quarters. `halves`: dark left half, light right half (a hard vertical edge at x=160). `ramp`: hue advances 6 degrees per frame, so every moment of the clip has its own colour. */
export interface VfxClip {
  color: string;
  seconds: number;
  pattern?: "bands" | "halves" | "ramp" | "greenscreen" | "frameid" | "texture";
  /** For `texture`: how the picture moves. `orbit` is a smooth loop, `shake` a slow pan plus random hand shake. Ground truth is in `window.__vfx.truth(clipIndex)`. */
  motion?: "orbit" | "shake" | "still";
  /** `overlay` puts the clip on a new track above the main track, starting at `start` seconds (default 0). */
  track?: "main" | "overlay";
  start?: number;
  /** Frame rate of the generated media (default 30). */
  fps?: number;
  /** Adds a 440 Hz sine soundtrack (opus) the length of the clip. */
  audio?: boolean;
}

/** The harness the pages of cc-*.spec.ts talk to; installed by `openVfxHarness`. */
export interface VfxHarness {
  mods: {
    model: typeof import("../src/engine/model");
    commands: typeof import("../src/engine/commands");
    timeline: typeof import("../src/engine/timeline");
    agent: typeof import("../src/engine/agent");
    time: typeof import("../src/engine/time");
  };
  editor: import("../src/engine/editor").Editor;
  ids: string[];
  /** Exports with audio and decodes the soundtrack (mono). */
  exportAudio(): Promise<{ durationSeconds: number; audioSeconds: number; samples: Float32Array; sampleRate: number }>;
  /** Ground-truth content displacement per frame (px) of a `texture` clip. */
  truth(clipIndex: number): Array<{ x: number; y: number }>;
  /** Runs an agent tool with the motion tools (real analyser, real worker) added. */
  callMotion(name: string, args: unknown): Promise<{ ok: boolean; error?: string; data?: unknown; summary?: string }>;
  /** Greyscale pixels of a frame of a generated clip, for picking a followable point. */
  textureLuma(clipIndex: number, seconds: number): Promise<{ width: number; height: number; data: Uint8Array }>;
  /** Frame ids (see decodeFrameId) of every frame of a `frameid` clip, decoded sequentially from the source file. */
  decodeFrameIds(clipIndex: number): Promise<number[]>;
  setChromaBackend(backend: "auto" | "gpu" | "cpu"): void;
  lastChromaBackend(): "gpu" | "cpu" | null;
  renderAt(seconds: number, points: Point[]): Promise<Rgb[]>;
  statsAt(seconds: number): Promise<PixelStats>;
  pngAt(seconds: number): Promise<string>;
  exportAt(input: { times: number[]; points: Point[]; stats?: boolean }): Promise<{ samples: Rgb[][]; durationSeconds: number; frames: number; stats?: PixelStats[] }>;
}

declare global {
  interface Window { __vfx: VfxHarness }
}

/** Pixel classes over the whole frame: red (r>180, g,b<90), blue, light (all >90), and the mean row of the white pixels. */
export interface PixelStats { red: number; blue: number; white: number; whiteCentroidY: number }

export const ARTIFACT_DIR = "e2e/.artifacts/vfx";

export function savePng(name: string, dataUrl: string): void {
  mkdirSync(ARTIFACT_DIR, { recursive: true });
  writeFileSync(`${ARTIFACT_DIR}/${name}.png`, Buffer.from(dataUrl.split(",")[1] ?? "", "base64"));
}

/**
 * Builds a project in the page out of solid-colour WebM clips (real encode, real decode) placed back to back on the
 * main track, and exposes render/export probes that run the shipped frame plan, compositor and exporter.
 */
export async function openVfxHarness(page: Page, clips: VfxClip[]): Promise<void> {
  await page.goto("/#/projects");
  const mediabunnyUrl = await mediabunnyModuleUrl(page);
  await page.evaluate(async ({ clips, mediabunnyUrl }) => {
    const mb = (await import(/* @vite-ignore */ mediabunnyUrl)) as typeof import("mediabunny");
    const load = <T>(url: string): Promise<T> => import(/* @vite-ignore */ url) as Promise<T>;
    const platformTracking = await load<typeof import("../src/platform/tracking")>("/src/platform/tracking/index.ts");
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
    const truthByClip: Array<Array<{ x: number; y: number }>> = [];
    async function solidWebm(color: string, seconds: number, pattern?: string, fps = 30, motion?: string, clipIndex = 0, withAudio = false): Promise<Blob> {
      const truth: Array<{ x: number; y: number }> = [];
      truthByClip[clipIndex] = truth;
      let world: OffscreenCanvas | null = null;
      const PAD = 80;
      if (pattern === "texture") {
        world = new OffscreenCanvas(W + 2 * PAD, H + 2 * PAD);
        const wctx = world.getContext("2d") as OffscreenCanvasRenderingContext2D;
        wctx.fillStyle = "#808080"; wctx.fillRect(0, 0, world.width, world.height);
        let state = 12345;
        const rnd = (): number => { state = (state * 1664525 + 1013904223) % 4294967296; return state / 4294967296; };
        for (let b = 0; b < 700; b++) {
          const x = rnd() * world.width, y = rnd() * world.height, r = 2 + rnd() * 5, v = rnd() < 0.5 ? 0 : 255;
          const g = wctx.createRadialGradient(x, y, 0, x, y, r);
          g.addColorStop(0, `rgba(${v},${v},${v},0.95)`); g.addColorStop(1, `rgba(${v},${v},${v},0)`);
          wctx.fillStyle = g; wctx.fillRect(x - r, y - r, 2 * r, 2 * r);
        }
        wctx.fillStyle = "#ff0000"; wctx.beginPath(); wctx.arc(PAD + 110, PAD + 70, 7, 0, Math.PI * 2); wctx.fill();
      }
      let jitterState = 777;
      const jitter = (): number => { jitterState = (jitterState * 1664525 + 1013904223) % 4294967296; return (jitterState / 4294967296 - 0.5) * 12; };
      const canvas = new OffscreenCanvas(W, H);
      const ctx = canvas.getContext("2d") as OffscreenCanvasRenderingContext2D;
      const output = new mb.Output({ format: new mb.WebMOutputFormat(), target: new mb.BufferTarget() });
      const video = new mb.CanvasSource(canvas, { codec: "vp9", bitrate: pattern === "frameid" || pattern === "texture" ? 12_000_000 : mb.QUALITY_HIGH });
      output.addVideoTrack(video, { frameRate: fps });
      let audioSource: InstanceType<typeof mb.AudioBufferSource> | null = null;
      if (withAudio) {
        audioSource = new mb.AudioBufferSource({ codec: "opus", bitrate: 96000 });
        output.addAudioTrack(audioSource);
      }
      await output.start();
      if (audioSource) {
        const rate = 48000;
        const buffer = new AudioBuffer({ length: Math.round(rate * seconds), sampleRate: rate, numberOfChannels: 1 });
        const data = buffer.getChannelData(0);
        for (let k = 0; k < data.length; k++) data[k] = Math.sin((2 * Math.PI * 440 * k) / rate) * 0.5;
        await audioSource.add(buffer);
        audioSource.close();
      }
      for (let i = 0; i < Math.round(seconds * fps); i++) {
        ctx.fillStyle = pattern === "ramp" ? `hsl(${(i * 6) % 360} 80% 50%)` : color;
        ctx.fillRect(0, 0, W, H);
        if (pattern === "texture" && world) {
          const at = motion === "orbit" ? { x: 30 * Math.sin(i / 22), y: 14 * Math.cos(i / 31) } : motion === "shake" ? { x: 0.25 * i + jitter(), y: 0.05 * i + jitter() } : { x: 0, y: 0 };
          truth.push({ x: at.x, y: at.y });
          ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = "high";
          ctx.drawImage(world, at.x - PAD, at.y - PAD);
        } else if (pattern === "bands") {
          ["#ff0000", "#00ff00", "#0000ff", "#808080"].forEach((c, band) => { ctx.fillStyle = c; ctx.fillRect(band * (W / 4), 0, W / 4, H); });
        } else if (pattern === "greenscreen") {
          ctx.fillStyle = "#00ff00"; ctx.fillRect(0, 0, W, H);
          ctx.fillStyle = "#c83232"; ctx.fillRect(110, 40, 100, 100);
          ctx.fillStyle = "#e0ac8c"; ctx.fillRect(230, 100, 40, 40);
        } else if (pattern === "frameid") {
          ctx.fillStyle = "#000000"; ctx.fillRect(0, 0, W, H);
          ctx.fillStyle = "#ffffff";
          for (let bit = 0; bit < 10; bit++) if ((i >> bit) & 1) ctx.fillRect(bit * 32, 0, 32, H);
        } else if (pattern === "halves") {
          ctx.fillStyle = "#404040"; ctx.fillRect(0, 0, W / 2, H);
          ctx.fillStyle = "#c0c0c0"; ctx.fillRect(W / 2, 0, W / 2, H);
        }
        await video.add(i / fps, 1 / fps);
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
      const blob = await solidWebm(clip.color, clip.seconds, clip.pattern, clip.fps ?? 30, clip.motion, i, clip.audio === true);
      const asset = {
        id: `asset-${i}`, name: `clip-${i}.webm`, type: "video" as const, size: blob.size, lastModified: 0,
        width: W, height: H, duration: time.mediaTimeFromSeconds(clip.seconds), fps: { numerator: clip.fps ?? 30, denominator: 1 }, hasAudio: clip.audio === true,
      };
      blobs.set(asset.id, blob);
      editor.registerAsset(asset);
      const elementId = `clip-${i}`;
      if (clip.track === "overlay") {
        editor.execute(commands.insertMediaElement({ asset, elementId, startTime: time.mediaTimeFromSeconds(clip.start ?? 0), placement: { mode: "newTrack", index: 0 } }));
      } else {
        editor.execute(commands.insertMediaElement({ asset, elementId, startTime: at, placement: { mode: "explicit", trackId: editor.tracks().main.id } }));
        at += asset.duration;
      }
      ids.push(elementId);
    }
    const getBlob = (id: string): Blob | undefined => blobs.get(id);

    const canvas = document.createElement("canvas");
    canvas.width = W; canvas.height = H;
    let compositor = new compositorMod.Compositor(canvas);
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
    window.__vfx = {
      exportAudio: async () => {
        const result = await exporterMod.exportProject({ doc: editor.getState().doc, getBlob, options: { format: "webm", quality: "high", includeAudio: true } });
        const input = new mb.Input({ source: new mb.BlobSource(result.blob), formats: mb.ALL_FORMATS });
        const track = await input.getPrimaryAudioTrack();
        if (!track) return { durationSeconds: result.durationSeconds, audioSeconds: 0, samples: new Float32Array(0), sampleRate: 0 };
        const sink = new mb.AudioBufferSink(track);
        const chunks: Float32Array[] = [];
        let sampleRate = 48000;
        for await (const wrapped of sink.buffers()) { sampleRate = wrapped.buffer.sampleRate; chunks.push(wrapped.buffer.getChannelData(0).slice()); }
        const samples = new Float32Array(chunks.reduce((n, c) => n + c.length, 0));
        let at = 0;
        for (const c of chunks) { samples.set(c, at); at += c.length; }
        return { durationSeconds: result.durationSeconds, audioSeconds: samples.length / sampleRate, samples, sampleRate };
      },
      truth: (clipIndex) => truthByClip[clipIndex] ?? [],
      callMotion: async (name, args) => {
        const analyzer = platformTracking.createMotionAnalyzer();
        const blobOf = (assetId: string): Blob => blobs.get(assetId) as Blob;
        const motionTools = agent.createMotionTools({
          track: ({ assetId, times, start }) => analyzer.track({ blob: blobOf(assetId), times, start }),
          camera: ({ assetId, times }) => analyzer.camera({ blob: blobOf(assetId), times }),
        });
        const registry = new Map(agent.createAgentTools());
        for (const tool of motionTools) registry.set(tool.name, tool);
        const result = await agent.callTool({ tools: registry, name, args, ctx: { editor, nowMs: () => 0 } });
        return result.ok ? { ok: true, data: result.data, summary: result.summary } : { ok: false, error: `${result.error} ${result.hint ?? ""}` };
      },
      textureLuma: async (clipIndex, seconds) => {
        const sink = new mb.CanvasSink((await new mb.Input({ source: new mb.BlobSource(blobs.get(`asset-${clipIndex}`) as Blob), formats: mb.ALL_FORMATS }).getPrimaryVideoTrack())!);
        const frame = await sink.getCanvas(seconds);
        const c = frame!.canvas as OffscreenCanvas;
        const d = (c.getContext("2d") as OffscreenCanvasRenderingContext2D).getImageData(0, 0, c.width, c.height).data;
        const luma = new Uint8Array(c.width * c.height);
        for (let k = 0; k < luma.length; k++) luma[k] = Math.round(0.299 * (d[4 * k] ?? 0) + 0.587 * (d[4 * k + 1] ?? 0) + 0.114 * (d[4 * k + 2] ?? 0));
        return { width: c.width, height: c.height, data: luma };
      },
      decodeFrameIds: async (clipIndex) => {
        const input = new mb.Input({ source: new mb.BlobSource(blobs.get(`asset-${clipIndex}`) as Blob), formats: mb.ALL_FORMATS });
        const sink = new mb.CanvasSink((await input.getPrimaryVideoTrack())!);
        const ids: number[] = [];
        for await (const frame of sink.canvases()) {
          const ctx = (frame.canvas as HTMLCanvasElement | OffscreenCanvas).getContext("2d") as CanvasRenderingContext2D;
          let id = 0;
          for (let bit = 0; bit < 10; bit++) { const d = ctx.getImageData(bit * 32 + 16, 90, 1, 1).data; if (((d[0] ?? 0) + (d[1] ?? 0) + (d[2] ?? 0)) / 3 > 128) id += 1 << bit; }
          ids.push(id);
        }
        return ids;
      },
      setChromaBackend: (backend) => { compositor = new compositorMod.Compositor(canvas, { chromaBackend: backend }); },
      lastChromaBackend: () => compositor.lastChromaBackend,
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

/** Decodes the frame index drawn by the `frameid` pattern from samples taken at `frameIdPoints()`. */
export const frameIdPoints = (y = 90): Point[] => Array.from({ length: 10 }, (_, bit) => [bit * 32 + 16, y] as Point);
export const decodeFrameId = (samples: Rgb[]): number => samples.reduce((id, rgb, bit) => id + ((rgb[0] + rgb[1] + rgb[2]) / 3 > 128 ? 1 << bit : 0), 0);

export const near = (actual: Rgb, expected: Rgb, tolerance = 28): boolean => actual.every((v, i) => Math.abs(v - (expected[i] as number)) <= tolerance);

/** Runs an agent tool in the page against the harness editor (the same registry the chat agent uses). */
export async function callAgentTool(page: Page, name: string, args: unknown): Promise<{ ok: boolean; error?: string; data?: unknown }> {
  return page.evaluate(async ({ name, args }) => {
    const { editor, mods } = window.__vfx;
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
