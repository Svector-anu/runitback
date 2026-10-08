import type { AgentTool, ToolResult } from "#/engine/agent";
import {
  analyzeTimelinePacing, timelineLoudness, trackInputsFromScene, type LevelCurve, type MediaAnalysis,
} from "#/engine/analysis";
import { currentScene } from "#/engine/commands";
import type { Editor } from "#/engine/editor";
import type { SceneTracks } from "#/engine/model";
import { totalDuration } from "#/engine/timeline";
import { TICKS_PER_SECOND } from "#/engine/time";
import {
  SHEET_MAX_FRAMES, describeMediaAnalysis, evenlySpacedTimes, summarizeMediaAnalysis, summarizeTimelineAnalysis,
} from "#/app/agent/analysis-summary";
import { blocksOf } from "./fixtures";
import { encodePng, toBase64, type Rgb } from "./png";
import { clipsOf, fixtureOf, sceneOf, type ClipView } from "./timeline";
import type { ResolvedFixture } from "./types";

const FRAME_WIDTH = 64;
const FRAME_HEIGHT = 36;
const BLACK: Rgb = [0, 0, 0];
const CAPTION_BAR: Rgb = [255, 255, 255];
const DEFAULT_SHEET_FRAMES = 6;

export interface StubWorld {
  editor: Editor;
  fixtures: ReadonlyArray<ResolvedFixture>;
  /** Precomputed analyses (exact ground truth) keyed by asset id. */
  analyses: ReadonlyMap<string, MediaAnalysis>;
}

const fail = (error: string, hint?: string): ToolResult => (hint === undefined ? { ok: false, error } : { ok: false, error, hint });

const hex = (rgb: Rgb): string => `#${rgb.map((n) => n.toString(16).padStart(2, "0")).join("")}`;

interface FrameLook {
  video: Rgb;
  hasCaption: boolean;
}

/** What the compositor would show at `seconds`, reduced to the colour of the topmost picture and whether text is on screen. */
function lookAt(input: { world: StubWorld; clips: ReadonlyArray<ClipView>; seconds: number }): FrameLook {
  const { world, clips, seconds } = input;
  const active = clips.filter((c) => c.start <= seconds + 1e-9 && seconds < c.end - 1e-9);
  const overlayOrder = sceneOf(world.editor.toProject()).tracks.overlay.map((t) => t.id);
  const visual = active
    .filter((c) => c.type === "video" || c.type === "image")
    .sort((a, b) => {
      const ia = a.lane === "main" ? overlayOrder.length : overlayOrder.indexOf(a.trackId);
      const ib = b.lane === "main" ? overlayOrder.length : overlayOrder.indexOf(b.trackId);
      return ia - ib;
    })[0];
  let video: Rgb = BLACK;
  if (visual) {
    const fixture = fixtureOf(world.fixtures, visual.mediaId);
    if (fixture) {
      const sourceTime = visual.trimStart + (seconds - visual.start) * visual.rate;
      const index = fixture.truth.shots.findIndex((s) => sourceTime >= s.start - 1e-9 && sourceTime < s.end - 1e-9);
      video = blocksOf(fixture.spec)[Math.max(0, index)]?.rgb ?? BLACK;
    }
  }
  return { video, hasCaption: active.some((c) => c.type === "text") };
}

function frameImage(look: FrameLook): { mediaType: "image/png"; base64: string } {
  const png = encodePng({
    width: FRAME_WIDTH,
    height: FRAME_HEIGHT,
    pixel: (x, y) => (look.hasCaption && y >= FRAME_HEIGHT - 6 && x > 8 && x < FRAME_WIDTH - 8 ? CAPTION_BAR : look.video),
  });
  return { mediaType: "image/png", base64: toBase64(png) };
}

function renderFrameTool(world: StubWorld): AgentTool {
  return {
    name: "render_frame",
    description: "Render the composed timeline at a time and return it as an image, exactly as preview and export would draw it. Use it to look at the result of an edit.",
    inputSchema: {
      type: "object",
      properties: {
        time: { type: "number", minimum: 0, description: "Timeline time in seconds (clamped to the last frame)." },
        maxSize: { type: "integer", minimum: 16, maximum: 2048, description: "Longest image side in pixels." },
      },
      required: ["time"],
      additionalProperties: false,
    },
    readOnly: true,
    run(input): ToolResult {
      const time = (input as { time?: unknown } | null)?.time;
      if (typeof time !== "number" || !Number.isFinite(time) || time < 0) return fail("'time' must be a non-negative number of seconds", 'Example: {"time": 2.5}');
      if (!world.editor.hasProject) return fail("No project is open in the editor");
      const clips = clipsOf(world.editor.toProject());
      const look = lookAt({ world, clips, seconds: time });
      const caption = `frame at ${time.toFixed(2)}s (${FRAME_WIDTH}x${FRAME_HEIGHT}, eval stub: video ${hex(look.video)}${look.hasCaption ? ", text on screen" : ""})`;
      return {
        ok: true, summary: `Rendered ${caption}`, data: { seconds: time, width: FRAME_WIDTH, height: FRAME_HEIGHT },
        images: [{ ...frameImage(look), caption }],
      };
    },
  };
}

function contactSheetTool(world: StubWorld): AgentTool {
  return {
    name: "render_contact_sheet",
    description: `Render several timeline moments as ONE labelled grid image. Pass either explicit 'times' or a 'count' of evenly spaced samples (max ${SHEET_MAX_FRAMES} frames).`,
    inputSchema: {
      type: "object",
      properties: {
        times: { type: "array", items: { type: "number", minimum: 0 }, description: "Timeline times in seconds, in display order." },
        count: { type: "integer", minimum: 1, maximum: SHEET_MAX_FRAMES, description: `Number of evenly spaced samples (default ${DEFAULT_SHEET_FRAMES}).` },
        columns: { type: "integer", minimum: 1, maximum: 8 },
      },
      additionalProperties: false,
    },
    readOnly: true,
    run(input): ToolResult {
      const args = (input ?? {}) as { times?: unknown; count?: unknown };
      if (!world.editor.hasProject) return fail("No project is open in the editor");
      const duration = totalDuration(currentScene(world.editor.getState().doc).tracks) / TICKS_PER_SECOND;
      if (duration <= 0) return fail("The timeline is empty", "Insert media first, then render a contact sheet.");
      let times: number[];
      if (args.times !== undefined) {
        if (!Array.isArray(args.times) || args.times.length === 0 || args.times.some((t) => typeof t !== "number" || !Number.isFinite(t) || t < 0)) {
          return fail("'times' must be a non-empty array of non-negative seconds");
        }
        if (args.times.length > SHEET_MAX_FRAMES) return fail(`At most ${SHEET_MAX_FRAMES} frames per sheet`);
        times = args.times as number[];
      } else {
        const count = typeof args.count === "number" ? args.count : DEFAULT_SHEET_FRAMES;
        times = evenlySpacedTimes({ durationSeconds: duration, count });
      }
      const clips = clipsOf(world.editor.toProject());
      const looks = times.map((seconds) => lookAt({ world, clips, seconds }));
      const png = encodePng({
        width: FRAME_WIDTH * looks.length,
        height: FRAME_HEIGHT,
        pixel: (x, y) => {
          const look = looks[Math.floor(x / FRAME_WIDTH)] as FrameLook;
          return look.hasCaption && y >= FRAME_HEIGHT - 6 ? CAPTION_BAR : look.video;
        },
      });
      const caption = `contact sheet of ${times.length} frames at ${times.map((t) => t.toFixed(1)).join(", ")}s (eval stub: ${looks.map((l) => hex(l.video)).join(" ")})`;
      return {
        ok: true, summary: `Rendered ${caption}`, data: { times, columns: times.length, rows: 1, width: FRAME_WIDTH * times.length, height: FRAME_HEIGHT },
        images: [{ mediaType: "image/png", base64: toBase64(png), caption }],
      };
    },
  };
}

function analyzeMediaTool(world: StubWorld): AgentTool {
  return {
    name: "analyze_media",
    description: "Measure one imported asset: silent ranges, speech-like ranges, scene cuts and shots (with motion level), loudness (dBFS), strongest audio onsets and estimated tempo. All times are SOURCE seconds of that asset. Lists are capped; '...Omitted' counts say how many were left out.",
    inputSchema: {
      type: "object",
      properties: { assetId: { type: "string", description: "Asset id from list_assets." } },
      required: ["assetId"],
      additionalProperties: false,
    },
    readOnly: true,
    run(input): ToolResult {
      const assetId = (input as { assetId?: unknown } | null)?.assetId;
      if (typeof assetId !== "string" || assetId === "") return fail("'assetId' must be a non-empty string", "Call list_assets to see valid ids.");
      if (!world.editor.hasProject) return fail("No project is open in the editor");
      const info = world.editor.getState().doc.assets.find((a) => a.id === assetId);
      if (!info) {
        const ids = world.editor.getState().doc.assets.map((a) => a.id).join(", ");
        return fail(`No asset with id "${assetId}"`, ids ? `Known asset ids: ${ids}.` : "The project has no assets; import media first.");
      }
      const analysis = world.analyses.get(assetId);
      if (!analysis) return fail(`Could not analyze "${info.name}": no media bytes`, "The file may be corrupt or use an unsupported codec.");
      const summary = summarizeMediaAnalysis(analysis);
      return { ok: true, summary: describeMediaAnalysis(summary), data: summary };
    },
  };
}

function withoutMuted(tracks: SceneTracks): SceneTracks {
  return { ...tracks, audio: tracks.audio.filter((t) => !t.muted), overlay: tracks.overlay.filter((t) => !("muted" in t) || !t.muted) };
}

function analyzeTimelineTool(world: StubWorld): AgentTool {
  return {
    name: "analyze_timeline",
    description: "Measure the current edit: cut pacing (average shot length, cuts per minute, histogram), dead air (spans with no video or audio), overlapping clips, and the loudness of the mixed audio in time windows (dBFS).",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    readOnly: true,
    run(): ToolResult {
      if (!world.editor.hasProject) return fail("No project is open in the editor");
      const tracks = currentScene(world.editor.effectiveDoc()).tracks;
      const pacing = analyzeTimelinePacing(trackInputsFromScene(tracks));
      if (pacing.durationSeconds <= 0) return fail("The timeline is empty", "Insert media first.");
      const audible = trackInputsFromScene(withoutMuted(tracks));
      const used = new Set(audible.flatMap((t) => t.clips.map((c) => c.mediaId).filter((id): id is string => id !== undefined)));
      const curves = new Map<string, LevelCurve>();
      for (const [assetId, analysis] of world.analyses) if (used.has(assetId) && analysis.levelCurve) curves.set(assetId, analysis.levelCurve);
      const windows = curves.size > 0 ? timelineLoudness({ tracks: audible, curves }) : null;
      const summary = summarizeTimelineAnalysis({ pacing, loudness: windows });
      return {
        ok: true,
        summary: `Timeline ${summary.durationSeconds}s, ${summary.cutsPerMinute} cuts/min, avg shot ${summary.averageShotLengthSeconds}s, dead air ${summary.deadAir.totalSeconds}s.`,
        data: summary,
      };
    },
  };
}

/** Deterministic stand-ins for the browser-only tools: exact analysis from the fixture declarations and tiny synthetic images. `export_project` is deliberately absent. */
export function createStubPlatformTools(world: StubWorld): AgentTool[] {
  return [renderFrameTool(world), contactSheetTool(world), analyzeMediaTool(world), analyzeTimelineTool(world)];
}
