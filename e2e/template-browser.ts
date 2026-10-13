import {
  ALL_FORMATS, AudioBufferSource, BlobSource, BufferTarget, CanvasSink, CanvasSource, Conversion, Input, Mp4OutputFormat, Output, QUALITY_MEDIUM,
  WebMOutputFormat,
} from "mediabunny";
import { currentScene, deleteElements, trimElementCommand } from "#/engine/commands";
import { documentDuration, Editor } from "#/engine/editor";
import { createProject, sequentialIds, type MediaAssetInfo } from "#/engine/model";
import { buildFramePlan } from "#/engine/render";
import { TICKS_PER_SECOND, mediaTimeFromSeconds } from "#/engine/time";
import { allElements } from "#/engine/timeline";
import {
  applyTemplateToEditor, templateFontFamilies, type ProjectTemplate, type RepeatItemInput, type TemplateInputs, type TemplateSlot, type TemplateWarning,
} from "#/engine/templates";
import { exportProject } from "#/export/exporter";
import { loadFont } from "#/platform/fonts";
import { CachedFrameSources, ImageCache } from "#/platform/frame-sources";
import { VideoFrameCache } from "#/platform/video-frames";
import { Compositor } from "#/render/compositor";
import { getTemplate } from "#/templates";

/** Page-side tooling for the template specs. Everything here is drawn procedurally and encoded for real; no third-party media. */

type Ctx = OffscreenCanvasRenderingContext2D;
type Painter = (ctx: Ctx, w: number, h: number, t: number) => void;

const TAU = Math.PI * 2;
const SANS = '"Inter", "Helvetica Neue", Arial, sans-serif';

function roundRect(ctx: Ctx, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
}

function bar(ctx: Ctx, x: number, y: number, w: number, h: number, color: string): void {
  ctx.fillStyle = color;
  roundRect(ctx, x, y, w, h, h / 2);
  ctx.fill();
}

interface Theme { bg0: string; bg1: string; panel: string; ink: string; mute: string; accent: string; accent2: string; sat: number }

const THEMES: Record<string, Theme> = {
  indigo: { bg0: "#0f1424", bg1: "#1a2144", panel: "#1b2342", ink: "#e8ecff", mute: "#5d6896", accent: "#5b6cff", accent2: "#3ddc97", sat: 1 },
  teal: { bg0: "#071a1f", bg1: "#0d2f37", panel: "#10303a", ink: "#dffaf4", mute: "#4f8a90", accent: "#2ec4b6", accent2: "#ffd166", sat: 1 },
  plum: { bg0: "#1a0f24", bg1: "#2b1647", panel: "#2c1b45", ink: "#f4e8ff", mute: "#8a63b8", accent: "#c77dff", accent2: "#ff6b6b", sat: 1 },
  light: { bg0: "#eef1f9", bg1: "#dfe5f5", panel: "#ffffff", ink: "#1b2240", mute: "#9aa3c4", accent: "#5b6cff", accent2: "#ff6b6b", sat: 1 },
  dull: { bg0: "#4a4d57", bg1: "#585b66", panel: "#5f626d", ink: "#c9ccd6", mute: "#8b8e99", accent: "#8a8d99", accent2: "#9a9da8", sat: 0.3 },
};

/** A dashboard-style app window with a moving cursor: stands in for a screen recording. */
function appPainter(themeName: string): Painter {
  const th = THEMES[themeName] ?? THEMES["indigo"] as Theme;
  return (ctx, w, h, t) => {
    const g = ctx.createLinearGradient(0, 0, w, h);
    g.addColorStop(0, th.bg0);
    g.addColorStop(1, th.bg1);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
    const u = w / 1280;
    ctx.save();
    ctx.scale(u, u);
    const W = 1280, H = h / u;
    // title bar
    ctx.fillStyle = th.panel;
    ctx.fillRect(0, 0, W, 52);
    ["#ff6b6b", "#ffd166", "#3ddc97"].forEach((c, i) => { ctx.fillStyle = c; ctx.beginPath(); ctx.arc(28 + i * 26, 26, 8, 0, TAU); ctx.fill(); });
    bar(ctx, 470, 16, 340, 20, th.bg1);
    // sidebar
    ctx.fillStyle = th.panel;
    ctx.fillRect(0, 52, 230, H - 52);
    const active = Math.floor(t / 1.6) % 6;
    for (let i = 0; i < 6; i++) {
      const y = 92 + i * 56;
      if (i === active) { ctx.fillStyle = th.accent; roundRect(ctx, 16, y - 12, 198, 44, 12); ctx.fill(); }
      bar(ctx, 52, y + 2, 90 + ((i * 37) % 50), 14, i === active ? "#ffffffee" : th.mute);
      ctx.fillStyle = i === active ? "#ffffff" : th.mute;
      roundRect(ctx, 28, y, 16, 16, 5);
      ctx.fill();
    }
    // header
    ctx.fillStyle = th.ink;
    ctx.font = `700 34px ${SANS}`;
    ctx.fillText(["Overview", "Projects", "Reports", "Team", "Billing", "Settings"][active] ?? "Overview", 270, 112);
    bar(ctx, 270, 128, 260, 12, th.mute);
    // stat cards
    for (let i = 0; i < 3; i++) {
      const x = 270 + i * 330;
      ctx.fillStyle = th.panel;
      roundRect(ctx, x, 170, 306, 150, 22);
      ctx.fill();
      bar(ctx, x + 24, 194, 90, 12, th.mute);
      ctx.fillStyle = th.ink;
      ctx.font = `700 48px ${SANS}`;
      ctx.fillText(["12,480", "98.7%", "2.4s"][i] ?? "", x + 24, 262);
      ctx.strokeStyle = i === 1 ? th.accent2 : th.accent;
      ctx.lineWidth = 4;
      ctx.beginPath();
      for (let k = 0; k <= 24; k++) {
        const px = x + 150 + k * 6;
        const py = 290 - 20 * Math.sin(k * 0.45 + t * 2 + i) - k * 0.8;
        if (k === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      }
      ctx.stroke();
    }
    // chart
    ctx.fillStyle = th.panel;
    roundRect(ctx, 270, 346, 640, 300, 22);
    ctx.fill();
    for (let i = 0; i < 14; i++) {
      const v = 0.35 + 0.55 * Math.abs(Math.sin(i * 0.7 + t * 1.3));
      ctx.fillStyle = i % 5 === 2 ? th.accent2 : th.accent;
      roundRect(ctx, 304 + i * 42, 620 - v * 230, 26, v * 230, 8);
      ctx.fill();
    }
    // table
    ctx.fillStyle = th.panel;
    roundRect(ctx, 934, 346, 300, 300, 22);
    ctx.fill();
    for (let i = 0; i < 6; i++) {
      ctx.fillStyle = i === Math.floor(t * 1.5) % 6 ? th.accent : th.bg1;
      ctx.beginPath();
      ctx.arc(966, 392 + i * 44, 12, 0, TAU);
      ctx.fill();
      bar(ctx, 992, 384 + i * 44, 120 + ((i * 29) % 60), 12, th.mute);
      bar(ctx, 1140, 384 + i * 44, 60, 12, th.bg1);
    }
    // cursor and click ripple
    const cx = 640 + 360 * Math.sin(t * 0.9), cy = 400 + 170 * Math.sin(t * 1.3 + 1);
    const phase = (t % 2) / 2;
    if (phase < 0.3) {
      ctx.strokeStyle = `rgba(255,255,255,${0.7 - phase * 2})`;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(cx, cy, 10 + phase * 90, 0, TAU);
      ctx.stroke();
    }
    ctx.fillStyle = "#ffffff";
    ctx.strokeStyle = "#101322";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx, cy + 30);
    ctx.lineTo(cx + 8, cy + 23);
    ctx.lineTo(cx + 15, cy + 36);
    ctx.lineTo(cx + 21, cy + 33);
    ctx.lineTo(cx + 14, cy + 21);
    ctx.lineTo(cx + 24, cy + 20);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.restore();
    if (th.sat < 1) {
      ctx.fillStyle = "rgba(90,90,96,0.35)";
      ctx.fillRect(0, 0, w, h);
    }
  };
}

/** Warm studio backdrop with a person talking: stands in for a creator clip. */
const talkingPainter: Painter = (ctx, w, h, t) => {
  const g = ctx.createLinearGradient(0, 0, w, h);
  g.addColorStop(0, "#ff9a8b");
  g.addColorStop(0.55, "#8b7bff");
  g.addColorStop(1, "#3b3f9e");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
  for (let i = 0; i < 9; i++) {
    ctx.fillStyle = `rgba(255,255,255,${0.06 + (i % 3) * 0.04})`;
    ctx.beginPath();
    ctx.arc(((i * 0.173 + 0.1) % 1) * w, ((i * 0.31 + 0.12) % 0.55) * h + Math.sin(t + i) * 8, 40 + (i % 4) * 26, 0, TAU);
    ctx.fill();
  }
  const sway = Math.sin(t * 1.4) * w * 0.012;
  const cx = w / 2 + sway, headY = h * 0.42, headR = w * 0.2;
  ctx.fillStyle = "#1c1f3a";
  roundRect(ctx, cx - w * 0.36, h * 0.6, w * 0.72, h * 0.5, w * 0.16);
  ctx.fill();
  ctx.fillStyle = "#e8b89a";
  ctx.fillRect(cx - headR * 0.32, headY + headR * 0.7, headR * 0.64, headR * 0.9);
  ctx.beginPath();
  ctx.ellipse(cx, headY, headR * 0.86, headR, 0, 0, TAU);
  ctx.fill();
  ctx.fillStyle = "#2b2020";
  ctx.beginPath();
  ctx.ellipse(cx, headY - headR * 0.35, headR * 0.92, headR * 0.75, 0, Math.PI, TAU);
  ctx.fill();
  ctx.fillStyle = "#1b1b2b";
  ctx.beginPath();
  ctx.arc(cx - headR * 0.33, headY - headR * 0.05, headR * 0.07, 0, TAU);
  ctx.arc(cx + headR * 0.33, headY - headR * 0.05, headR * 0.07, 0, TAU);
  ctx.fill();
  ctx.fillStyle = "#8a2f3d";
  const open = 0.25 + 0.75 * Math.abs(Math.sin(t * 9));
  ctx.beginPath();
  ctx.ellipse(cx, headY + headR * 0.45, headR * 0.28, headR * 0.1 * open + 3, 0, 0, TAU);
  ctx.fill();
};

/** Soft landscape: stands in for b-roll. */
function brollPainter(hue: number): Painter {
  return (ctx, w, h, t) => {
    const g = ctx.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, `hsl(${hue} 70% 62%)`);
    g.addColorStop(1, `hsl(${(hue + 40) % 360} 80% 82%)`);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = `hsla(${(hue + 30) % 360} 90% 90% / 0.95)`;
    ctx.beginPath();
    ctx.arc(w * (0.25 + 0.5 * ((t * 0.05) % 1)), h * 0.28, Math.min(w, h) * 0.1, 0, TAU);
    ctx.fill();
    for (let layer = 0; layer < 3; layer++) {
      ctx.fillStyle = `hsl(${(hue + 150 + layer * 18) % 360} ${40 + layer * 8}% ${46 - layer * 12}%)`;
      ctx.beginPath();
      ctx.moveTo(0, h);
      for (let x = 0; x <= w; x += 12) ctx.lineTo(x, h * (0.62 + layer * 0.1) + Math.sin(x * 0.006 + layer * 2 + t * 0.4) * h * 0.05);
      ctx.lineTo(w, h);
      ctx.fill();
    }
  };
}

async function encodeVideo(input: { width: number; height: number; seconds: number; fps: number; paint: Painter }): Promise<Blob> {
  const canvas = new OffscreenCanvas(input.width, input.height);
  const ctx = canvas.getContext("2d") as Ctx;
  const output = new Output({ format: new WebMOutputFormat(), target: new BufferTarget() });
  const video = new CanvasSource(canvas, { codec: "vp9", bitrate: QUALITY_MEDIUM });
  output.addVideoTrack(video, { frameRate: input.fps });
  await output.start();
  const frames = Math.round(input.seconds * input.fps);
  for (let i = 0; i < frames; i++) {
    input.paint(ctx, input.width, input.height, i / input.fps);
    await video.add(i / input.fps, 1 / input.fps);
  }
  await output.finalize();
  return new Blob([(output.target as BufferTarget).buffer as ArrayBuffer], { type: "video/webm" });
}

async function encodeTone(seconds: number): Promise<Blob> {
  const output = new Output({ format: new WebMOutputFormat(), target: new BufferTarget() });
  const audio = new AudioBufferSource({ codec: "opus", bitrate: 64_000 });
  output.addAudioTrack(audio);
  await output.start();
  const rate = 48_000;
  const buffer = new AudioBuffer({ length: Math.round(seconds * rate), sampleRate: rate, numberOfChannels: 1 });
  const data = buffer.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.sin((TAU * 220 * i) / rate) * 0.2;
  await audio.add(buffer);
  audio.close();
  await output.finalize();
  return new Blob([(output.target as BufferTarget).buffer as ArrayBuffer], { type: "audio/webm" });
}

async function pngOf(width: number, height: number, draw: (ctx: Ctx, w: number, h: number) => void): Promise<Blob> {
  const canvas = new OffscreenCanvas(width, height);
  draw(canvas.getContext("2d") as Ctx, width, height);
  return canvas.convertToBlob({ type: "image/png" });
}

const portraitImage = (): Promise<Blob> => pngOf(960, 1200, (ctx, w, h) => {
  const g = ctx.createLinearGradient(0, 0, w, h);
  g.addColorStop(0, "#ffd9a8");
  g.addColorStop(1, "#7b8cff");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = "#26304f";
  roundRect(ctx, w * 0.1, h * 0.66, w * 0.8, h * 0.6, w * 0.2);
  ctx.fill();
  ctx.fillStyle = "#d9a07d";
  ctx.fillRect(w * 0.42, h * 0.5, w * 0.16, h * 0.18);
  ctx.beginPath();
  ctx.ellipse(w / 2, h * 0.4, w * 0.2, h * 0.17, 0, 0, TAU);
  ctx.fill();
  ctx.fillStyle = "#3a2a2a";
  ctx.beginPath();
  ctx.ellipse(w / 2, h * 0.34, w * 0.215, h * 0.14, 0, Math.PI, TAU);
  ctx.fill();
  ctx.fillStyle = "#1b1b2b";
  ctx.beginPath();
  ctx.arc(w * 0.44, h * 0.4, 9, 0, TAU);
  ctx.arc(w * 0.56, h * 0.4, 9, 0, TAU);
  ctx.fill();
  ctx.strokeStyle = "#8a4b3d";
  ctx.lineWidth = 7;
  ctx.beginPath();
  ctx.arc(w / 2, h * 0.44, w * 0.06, 0.15 * Math.PI, 0.85 * Math.PI);
  ctx.stroke();
});

const logoImage = (): Promise<Blob> => pngOf(512, 512, (ctx, w, h) => {
  const g = ctx.createLinearGradient(0, 0, w, h);
  g.addColorStop(0, "#7a86ff");
  g.addColorStop(1, "#3a46d6");
  ctx.fillStyle = g;
  roundRect(ctx, 32, 32, w - 64, h - 64, 110);
  ctx.fill();
  ctx.fillStyle = "#ffffff";
  ctx.beginPath();
  ctx.moveTo(196, 150);
  ctx.lineTo(196, 362);
  ctx.lineTo(372, 256);
  ctx.closePath();
  ctx.fill();
});

// ---- Template fill ------------------------------------------------------------------------------------------------

const BROLL_HUES = [210, 30, 330, 150, 270];
const ITEM_TITLES = ["Light it from the side", "Cut on the action", "Keep the audio clean", "End on a question", "Hook in three seconds"];

/** Words that make the previews read like real videos. A template listed here overrides the placeholder text of the ids named. */
const PREVIEW_TEXTS: Record<string, Record<string, string>> = {
  "product-launch": { headline: "Meet the faster way to work", "callout-1": "Plan everything in one place", "callout-2": "Share with a single click", "callout-3": "Ship before lunch" },
};

/** Seconds and look of each preview. */
export const PREVIEW_PLAN: Record<string, { seconds: number; posterAt: number }> = {
  "product-launch": { seconds: 8, posterAt: 1.6 },
  "kinetic-announcement": { seconds: 7, posterAt: 2.6 },
  "feature-callouts": { seconds: 8, posterAt: 7 },
  "before-after": { seconds: 8, posterAt: 7 },
  listicle: { seconds: 8, posterAt: 5.2 },
  "testimonial-quote": { seconds: 8, posterAt: 7 },
  "talking-head-captions": { seconds: 6, posterAt: 1.5 },
  "metric-changelog": { seconds: 8, posterAt: 6 },
};

interface MadeAsset { info: MediaAssetInfo; blob: Blob }

async function makeAsset(input: { id: string; slot: TemplateSlot; variant: number; templateId: string }): Promise<MadeAsset> {
  const { id, slot, variant } = input;
  const base = { id, size: 1, lastModified: 0 };
  if (slot.kind === "audio") {
    const blob = await encodeTone(40);
    return { blob, info: { ...base, name: `${id}.webm`, type: "audio", size: blob.size, duration: mediaTimeFromSeconds(40) } };
  }
  if (slot.kind === "image") {
    const portrait = /portrait/i.test(slot.label);
    const blob = await (portrait ? portraitImage() : logoImage());
    return { blob, info: { ...base, name: `${id}.png`, type: "image", size: blob.size, width: portrait ? 960 : 512, height: portrait ? 1200 : 512 } };
  }
  const vertical = slot.aspect === "9:16";
  const width = vertical ? 540 : 1280, height = vertical ? 960 : 720;
  const seconds = Math.max(8, (slot.expectedSeconds ?? 8) + 3);
  const talking = vertical && /talking/i.test(slot.label);
  const dull = input.templateId === "before-after" && /before/i.test(slot.label);
  const paint = talking ? talkingPainter
    : vertical ? brollPainter(BROLL_HUES[variant % BROLL_HUES.length] ?? 210)
      : appPainter(dull ? "dull" : ["indigo", "teal", "plum"][variant % 3] ?? "indigo");
  const blob = await encodeVideo({ width, height, seconds, fps: 30, paint });
  return { blob, info: { ...base, name: `${id}.webm`, type: "video", size: blob.size, width, height, duration: mediaTimeFromSeconds(seconds), fps: { numerator: 30, denominator: 1 }, hasAudio: false } };
}

export interface TemplateHarness {
  editor: Editor;
  template: ProjectTemplate;
  warnings: TemplateWarning[];
  getBlob(mediaId: string): Blob | undefined;
}

export interface BuildOptions {
  /** Leave optional audio slots empty (the previews are silent). Default true. */
  skipAudio?: boolean;
  items?: number;
}

/** A fresh project holding generated media for every slot of the template, with the template applied. */
export async function buildTemplateProject(templateId: string, options: BuildOptions = {}): Promise<TemplateHarness> {
  const template = getTemplate(templateId);
  if (!template) throw new Error(`unknown template ${templateId}`);
  await Promise.all(templateFontFamilies(template).map((family) => loadFont(family)));
  const newId = sequentialIds("tp");
  const now = "2026-01-01T00:00:00.000Z";
  const editor = new Editor({ newId, now: () => now });
  editor.load({ project: createProject({ id: `preview-${templateId}`, name: template.name, ids: newId, now }), assets: [] });
  const blobs = new Map<string, Blob>();
  let variant = 0;
  const fill = async (slots: ReadonlyArray<TemplateSlot>, prefix: string): Promise<Record<string, string>> => {
    const out: Record<string, string> = {};
    for (const slot of slots) {
      if (slot.kind === "audio" && options.skipAudio !== false) continue;
      const made = await makeAsset({ id: `${prefix}${slot.id}`, slot, variant: variant++, templateId });
      blobs.set(made.info.id, made.blob);
      editor.registerAsset(made.info);
      out[slot.id] = made.info.id;
    }
    return out;
  };
  const inputs: TemplateInputs = { slots: await fill(template.slots, ""), texts: PREVIEW_TEXTS[templateId] ?? {} };
  if (template.repeat) {
    const repeat: Record<string, RepeatItemInput[]> = {};
    for (const group of template.repeat) {
      const items: RepeatItemInput[] = [];
      for (let i = 0; i < (options.items ?? 4); i++) {
        items.push({ slots: await fill(group.slots, `${group.id}-${i}-`), texts: group.texts.some((t) => t.id === "title") ? { title: ITEM_TITLES[i % ITEM_TITLES.length] ?? "" } : {} });
      }
      repeat[group.id] = items;
    }
    inputs.repeat = repeat;
  }
  const result = applyTemplateToEditor(editor, template, inputs, { requireAllSlots: true });
  return { editor, template, warnings: result.warnings, getBlob: (id) => blobs.get(id) };
}

function renderer(harness: TemplateHarness, width: number, height: number) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const compositor = new Compositor(canvas);
  const frames = new VideoFrameCache(harness.getBlob);
  const sources = new CachedFrameSources(frames, new ImageCache(harness.getBlob));
  return {
    canvas,
    async renderAt(seconds: number): Promise<void> {
      const doc = harness.editor.getState().doc;
      const plan = buildFramePlan({ tracks: currentScene(doc).tracks, canvas: { width, height }, background: doc.settings.background, assets: doc.assets, time: mediaTimeFromSeconds(seconds) });
      await compositor.render(plan, sources);
    },
  };
}

const toBase64 = async (blob: Blob): Promise<string> => {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
};

/** The frame at `seconds` as a webp that is `width` px wide. */
export async function posterWebp(harness: TemplateHarness, input: { seconds: number; width: number }): Promise<{ base64: string; bytes: number; width: number; height: number }> {
  const { canvasSize } = harness.editor.getState().doc.settings;
  const r = renderer(harness, canvasSize.width, canvasSize.height);
  await r.renderAt(input.seconds);
  const height = Math.round((input.width * canvasSize.height) / canvasSize.width);
  const small = new OffscreenCanvas(input.width, height);
  const sctx = small.getContext("2d") as Ctx;
  sctx.imageSmoothingQuality = "high";
  sctx.drawImage(r.canvas, 0, 0, input.width, height);
  let quality = 0.82;
  let blob = await small.convertToBlob({ type: "image/webp", quality });
  while (blob.size > 60_000 && quality > 0.4) {
    quality -= 0.1;
    blob = await small.convertToBlob({ type: "image/webp", quality });
  }
  return { base64: await toBase64(blob), bytes: blob.size, width: input.width, height };
}

/** A frame as PNG for eyeballing layout during development. */
export async function framePng(harness: TemplateHarness, input: { seconds: number; width: number }): Promise<string> {
  const { canvasSize } = harness.editor.getState().doc.settings;
  const r = renderer(harness, canvasSize.width, canvasSize.height);
  await r.renderAt(input.seconds);
  const height = Math.round((input.width * canvasSize.height) / canvasSize.width);
  const small = new OffscreenCanvas(input.width, height);
  (small.getContext("2d") as Ctx).drawImage(r.canvas, 0, 0, input.width, height);
  return toBase64(await small.convertToBlob({ type: "image/png" }));
}

/** Cuts the open timeline to its first `seconds`, with the editor's own trim and delete commands. */
function keepFirst(editor: Editor, seconds: number): void {
  const end = mediaTimeFromSeconds(seconds);
  const located = allElements(currentScene(editor.getState().doc).tracks);
  const gone = located.filter((l) => l.element.startTime >= end).map((l) => l.ref);
  if (gone.length > 0) editor.execute(deleteElements(gone));
  for (const l of allElements(currentScene(editor.getState().doc).tracks)) {
    if (l.element.startTime + l.element.duration > end) editor.execute(trimElementCommand({ ref: l.ref, end }));
  }
}

export interface PreviewVideo { base64: string; bytes: number; width: number; height: number; fps: number; bitrate: number; seconds: number; fullExportBytes: number; frames: number }

/**
 * Exports the first `seconds` of the template with the real exporter, then re-encodes that export small (resize, 15 fps, low
 * bitrate, no audio) until it is under `maxBytes`.
 */
export async function previewMp4(harness: TemplateHarness, input: { seconds: number; maxBytes: number; longEdge: number }): Promise<PreviewVideo> {
  keepFirst(harness.editor, input.seconds);
  const doc = harness.editor.getState().doc;
  const exported = await exportProject({ doc, getBlob: harness.getBlob, options: { format: "mp4", quality: "high", includeAudio: false } });
  const portrait = exported.height > exported.width;
  const scale = input.longEdge / Math.max(exported.width, exported.height);
  const width = Math.round((exported.width * scale) / 2) * 2, height = Math.round((exported.height * scale) / 2) * 2;
  for (const bitrate of [520_000, 380_000, 280_000, 200_000, 140_000, 90_000]) {
    const output = new Output({ format: new Mp4OutputFormat({ fastStart: "in-memory" }), target: new BufferTarget() });
    const conversion = await Conversion.init({
      input: new Input({ source: new BlobSource(exported.blob), formats: ALL_FORMATS }), output,
      video: { width, height, fit: "fill", frameRate: 15, bitrate, codec: "avc" }, audio: { discard: true },
    });
    await conversion.execute();
    const blob = new Blob([(output.target as BufferTarget).buffer as ArrayBuffer], { type: "video/mp4" });
    if (blob.size <= input.maxBytes || bitrate === 90_000) {
      return {
        base64: await toBase64(blob), bytes: blob.size, width: portrait ? Math.min(width, height) : width, height: portrait ? Math.max(width, height) : height,
        fps: 15, bitrate, seconds: exported.durationSeconds, fullExportBytes: exported.blob.size, frames: exported.frameCount,
      };
    }
  }
  throw new Error("unreachable");
}

export interface ExportCheck { durationSeconds: number; expectedSeconds: number; frames: number; width: number; height: number; samples: Array<{ at: number; mean: number; nonBlack: number }>; hasAudio: boolean }

/** Exports the whole template as WebM and decodes frames from the file: how bright they are and how much of each is not black. */
export async function exportAndSample(harness: TemplateHarness, times: number[]): Promise<ExportCheck> {
  const doc = harness.editor.getState().doc;
  const expected = documentDuration(doc) / TICKS_PER_SECOND;
  const result = await exportProject({ doc, getBlob: harness.getBlob, options: { format: "webm", quality: "medium", includeAudio: false } });
  const input = new Input({ source: new BlobSource(result.blob), formats: ALL_FORMATS });
  const track = await input.getPrimaryVideoTrack();
  if (!track) throw new Error("the export has no video track");
  const sink = new CanvasSink(track);
  const samples: ExportCheck["samples"] = [];
  for (const at of times) {
    const wrapped = await sink.getCanvas(at);
    if (!wrapped) throw new Error(`no frame at ${at}s`);
    const c = wrapped.canvas as HTMLCanvasElement | OffscreenCanvas;
    const ctx = c.getContext("2d") as CanvasRenderingContext2D;
    const { data } = ctx.getImageData(0, 0, c.width, c.height);
    let sum = 0, lit = 0;
    for (let i = 0; i < data.length; i += 4) {
      const luma = 0.2126 * (data[i] ?? 0) + 0.7152 * (data[i + 1] ?? 0) + 0.0722 * (data[i + 2] ?? 0);
      sum += luma;
      if (luma > 24) lit++;
    }
    samples.push({ at, mean: sum / (data.length / 4), nonBlack: lit / (data.length / 4) });
  }
  return { durationSeconds: await input.computeDuration(), expectedSeconds: expected, frames: result.frameCount, width: result.width, height: result.height, samples, hasAudio: result.hasAudio };
}

