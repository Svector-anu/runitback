import type { AgentTool, ToolResult } from "#/engine/agent";
import {
  analyzeTimelinePacing, timelineLoudness, trackInputsFromScene, type LevelCurve, type LoudnessWindow,
} from "#/engine/analysis";
import { currentScene } from "#/engine/commands";
import type { Editor } from "#/engine/editor";
import type { MediaAssetInfo, SceneTracks } from "#/engine/model";
import { buildFramePlan } from "#/engine/render";
import { clampTime, lastFrameTime, mediaTimeFromSeconds, roundToFrame } from "#/engine/time";
import { totalDuration } from "#/engine/timeline";
import { exportProject } from "#/export/exporter";
import { DEFAULT_EXPORT_OPTIONS, exportFileName, type ExportOptions } from "#/export/plan";
import { renderFrameJpeg, DEFAULT_FRAME_MAX_SIZE, MAX_FRAME_MAX_SIZE } from "#/platform/agent-bridge-frame";
import { IdbAnalysisStore, analyzeMedia, type AnalysisStore } from "#/platform/analysis";
import { CachedFrameSources } from "#/platform/frame-sources";
import type { MediaRuntime } from "#/platform/media-runtime";
import { createCanvas } from "#/render/canvas";
import { Compositor } from "#/render/compositor";
import { blobToBase64, framePlanFrameSource, renderContactSheet } from "#/render/contact-sheet";
import {
  SHEET_MAX_FRAMES, describeMediaAnalysis, evenlySpacedTimes, sheetCellSize, summarizeMediaAnalysis, summarizeTimelineAnalysis,
} from "./analysis-summary";

const QUALITIES: ReadonlyArray<ExportOptions["quality"]> = ["low", "medium", "high", "very_high"];
const FORMATS: ReadonlyArray<ExportOptions["format"]> = ["mp4", "webm"];
const DEFAULT_SHEET_FRAMES = 6;

export interface PendingExport {
  blob: Blob;
  fileName: string;
}

/** What platform tools need from the running app. Getters, so a project switch is always picked up. */
export interface PlatformToolDeps {
  editor: Editor;
  runtime: () => MediaRuntime;
  analysisStore: () => AnalysisStore;
  /** Aborts long analyses when the user stops the agent. */
  signal?: () => AbortSignal | undefined;
  onExport?: (result: PendingExport) => void;
}

const fail = (error: string, hint?: string): ToolResult => (hint === undefined ? { ok: false, error } : { ok: false, error, hint });

function numberInRange(value: unknown, min: number, max: number): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max ? value : null;
}

const NO_PROJECT = fail("No project is open in the editor", "Open a project in the browser tab first.");

function renderFrameTool(deps: PlatformToolDeps): AgentTool {
  return {
    name: "render_frame",
    description: "Render the composed timeline at a time and return it as a JPEG image, exactly as preview and export would draw it. Use it to look at the result of an edit.",
    inputSchema: {
      type: "object",
      properties: {
        time: { type: "number", minimum: 0, description: "Timeline time in seconds (clamped to the last frame)." },
        maxSize: { type: "integer", minimum: 16, maximum: MAX_FRAME_MAX_SIZE, description: `Longest image side in pixels (default ${DEFAULT_FRAME_MAX_SIZE}).` },
      },
      required: ["time"],
      additionalProperties: false,
    },
    readOnly: true,
    async run(input): Promise<ToolResult> {
      const args = (input ?? {}) as { time?: unknown; maxSize?: unknown };
      if (typeof args.time !== "number" || !Number.isFinite(args.time) || args.time < 0) {
        return fail("'time' must be a non-negative number of seconds", 'Example: {"time": 2.5}');
      }
      const maxSize = args.maxSize === undefined ? undefined : numberInRange(args.maxSize, 16, MAX_FRAME_MAX_SIZE);
      if (args.maxSize !== undefined && maxSize === null) return fail(`'maxSize' must be a number between 16 and ${MAX_FRAME_MAX_SIZE}`);
      if (!deps.editor.hasProject) return NO_PROJECT;
      const frame = await renderFrameJpeg({ doc: deps.editor.effectiveDoc(), runtime: deps.runtime(), seconds: args.time, maxSize: maxSize ?? undefined });
      const caption = `frame at ${frame.seconds.toFixed(2)}s (${frame.width}x${frame.height})`;
      return {
        ok: true,
        summary: `Rendered ${caption}`,
        data: { seconds: frame.seconds, width: frame.width, height: frame.height },
        images: [{ mediaType: "image/jpeg", base64: frame.base64, caption }],
      };
    },
  };
}

function contactSheetTool(deps: PlatformToolDeps): AgentTool {
  return {
    name: "render_contact_sheet",
    description: `Render several timeline moments as ONE labelled grid image (timecode on each cell, long side <= 1024 px). Far cheaper than many render_frame calls for checking the overall flow, pacing and continuity. Pass either explicit 'times' or a 'count' of evenly spaced samples (max ${SHEET_MAX_FRAMES} frames).`,
    inputSchema: {
      type: "object",
      properties: {
        times: { type: "array", items: { type: "number", minimum: 0 }, description: "Timeline times in seconds, in display order." },
        count: { type: "integer", minimum: 1, maximum: SHEET_MAX_FRAMES, description: `Number of evenly spaced samples across the timeline (default ${DEFAULT_SHEET_FRAMES}). Ignored when 'times' is given.` },
        columns: { type: "integer", minimum: 1, maximum: 8, description: "Grid columns (default: about the square root of the frame count)." },
      },
      additionalProperties: false,
    },
    readOnly: true,
    async run(input): Promise<ToolResult> {
      const args = (input ?? {}) as { times?: unknown; count?: unknown; columns?: unknown };
      if (!deps.editor.hasProject) return NO_PROJECT;
      const doc = deps.editor.effectiveDoc();
      const tracks = currentScene(doc).tracks;
      const duration = totalDuration(tracks);
      if (duration <= 0) return fail("The timeline is empty", "Insert media first, then render a contact sheet.");
      const durationSeconds = duration / mediaTimeFromSeconds(1);

      let times: number[];
      if (args.times !== undefined) {
        if (!Array.isArray(args.times) || args.times.length === 0 || args.times.some((t) => typeof t !== "number" || !Number.isFinite(t) || t < 0)) {
          return fail("'times' must be a non-empty array of non-negative seconds", 'Example: {"times": [0, 2.5, 5]}');
        }
        if (args.times.length > SHEET_MAX_FRAMES) return fail(`At most ${SHEET_MAX_FRAMES} frames per sheet`, "Split the request into several sheets.");
        times = args.times as number[];
      } else {
        const count = args.count === undefined ? DEFAULT_SHEET_FRAMES : numberInRange(args.count, 1, SHEET_MAX_FRAMES);
        if (count === null) return fail(`'count' must be an integer between 1 and ${SHEET_MAX_FRAMES}`);
        times = evenlySpacedTimes({ durationSeconds, count });
      }
      const requestedColumns = args.columns === undefined ? Math.ceil(Math.sqrt(times.length)) : numberInRange(args.columns, 1, 8);
      if (requestedColumns === null) return fail("'columns' must be an integer between 1 and 8");
      const columns = Math.max(1, Math.min(Math.floor(requestedColumns), times.length));

      const canvasSize = doc.settings.canvasSize;
      const last = lastFrameTime(duration, doc.settings.fps);
      const compositor = new Compositor(createCanvas(canvasSize.width, canvasSize.height));
      const sources = new CachedFrameSources(deps.runtime().video, deps.runtime().images);
      const frameAt = framePlanFrameSource({
        compositor,
        sources,
        buildPlan: (seconds) => buildFramePlan({
          tracks, canvas: canvasSize, background: doc.settings.background, assets: doc.assets,
          time: roundToFrame(clampTime(mediaTimeFromSeconds(seconds), 0, last), doc.settings.fps),
        }),
      });
      const sheet = await renderContactSheet({
        times, columns, frameAt, signal: deps.signal?.(),
        cell: sheetCellSize({ canvas: canvasSize, columns, frameCount: times.length }),
      });
      const caption = `contact sheet of ${times.length} frames at ${times.map((t) => t.toFixed(1)).join(", ")}s (${sheet.width}x${sheet.height})`;
      return {
        ok: true,
        summary: `Rendered ${caption}`,
        data: { times, columns: sheet.plan.columns, rows: sheet.plan.rows, width: sheet.width, height: sheet.height },
        images: [{ mediaType: "image/jpeg", base64: await blobToBase64(sheet.blob), caption }],
      };
    },
  };
}

async function analysisFor(deps: PlatformToolDeps, info: MediaAssetInfo): Promise<{ ok: true; analysis: Awaited<ReturnType<typeof analyzeMedia>> } | { ok: false; result: ToolResult }> {
  const blob = deps.runtime().getBlob(info.id);
  if (!blob) return { ok: false, result: fail(`The media bytes for asset "${info.id}" are not available`, "Re-import the file, then try again.") };
  try {
    return { ok: true, analysis: await analyzeMedia(blob, info, { store: deps.analysisStore(), signal: deps.signal?.() }) };
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    return { ok: false, result: fail(`Could not analyze "${info.name}": ${error instanceof Error ? error.message : String(error)}`, "The file may be corrupt or use an unsupported codec.") };
  }
}

function analyzeMediaTool(deps: PlatformToolDeps): AgentTool {
  return {
    name: "analyze_media",
    description: "Measure one imported asset: silent ranges, speech-like ranges, scene cuts and shots (with motion level), loudness (dBFS), strongest audio onsets and estimated tempo. All times are SOURCE seconds of that asset. Results are cached, so repeat calls are cheap; the first call on long media can take a while. Lists are capped; '...Omitted' counts say how many were left out.",
    inputSchema: {
      type: "object",
      properties: { assetId: { type: "string", description: "Asset id from list_assets." } },
      required: ["assetId"],
      additionalProperties: false,
    },
    readOnly: true,
    async run(input): Promise<ToolResult> {
      const assetId = (input as { assetId?: unknown } | null)?.assetId;
      if (typeof assetId !== "string" || assetId === "") return fail("'assetId' must be a non-empty string", "Call list_assets to see valid ids.");
      if (!deps.editor.hasProject) return NO_PROJECT;
      const info = deps.editor.getState().doc.assets.find((a) => a.id === assetId);
      if (!info) {
        const ids = deps.editor.getState().doc.assets.map((a) => a.id).slice(0, 12).join(", ");
        return fail(`No asset with id "${assetId}"`, ids ? `Known asset ids: ${ids}.` : "The project has no assets; import media first.");
      }
      const outcome = await analysisFor(deps, info);
      if (!outcome.ok) return outcome.result;
      const summary = summarizeMediaAnalysis(outcome.analysis);
      return { ok: true, summary: describeMediaAnalysis(summary), data: summary };
    },
  };
}

function withoutMuted(tracks: SceneTracks): SceneTracks {
  return { ...tracks, audio: tracks.audio.filter((t) => !t.muted), overlay: tracks.overlay.filter((t) => !("muted" in t) || !t.muted) };
}

function analyzeTimelineTool(deps: PlatformToolDeps): AgentTool {
  return {
    name: "analyze_timeline",
    description: "Measure the current edit: cut pacing (average shot length, cuts per minute, histogram), dead air (spans with no video or audio), overlapping clips, and the loudness of the mixed audio in time windows (dBFS, ignores clip gain and fades). May analyze audio of used assets on first call (cached). Use it to verify pacing and audio level after editing.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    readOnly: true,
    async run(): Promise<ToolResult> {
      if (!deps.editor.hasProject) return NO_PROJECT;
      const doc = deps.editor.effectiveDoc();
      const tracks = currentScene(doc).tracks;
      const pacing = analyzeTimelinePacing(trackInputsFromScene(tracks));
      if (pacing.durationSeconds <= 0) return fail("The timeline is empty", "Insert media first.");

      const audibleTracks = trackInputsFromScene(withoutMuted(tracks));
      const usedIds = new Set(audibleTracks.flatMap((t) => t.clips.map((c) => c.mediaId).filter((id): id is string => id !== undefined)));
      const curves = new Map<string, LevelCurve>();
      const skipped: string[] = [];
      for (const info of doc.assets) {
        if (!usedIds.has(info.id) || info.type === "image" || info.hasAudio === false) continue;
        const outcome = await analysisFor(deps, info);
        if (!outcome.ok) {
          skipped.push(info.name);
          continue;
        }
        if (outcome.analysis.levelCurve) curves.set(info.id, outcome.analysis.levelCurve);
      }
      const windows: LoudnessWindow[] | null = curves.size > 0 ? timelineLoudness({ tracks: audibleTracks, curves }) : null;
      const summary = summarizeTimelineAnalysis({ pacing, loudness: windows });
      const note = skipped.length ? ` Loudness ignored unreadable media: ${skipped.join(", ")}.` : "";
      return {
        ok: true,
        summary: `Timeline ${summary.durationSeconds}s, ${summary.cutsPerMinute} cuts/min, avg shot ${summary.averageShotLengthSeconds}s, dead air ${summary.deadAir.totalSeconds}s.${note}`,
        data: summary,
      };
    },
  };
}

function exportTool(deps: PlatformToolDeps): AgentTool {
  let running = false;
  return {
    name: "export_project",
    description: "Export the whole timeline to a video file in the browser and report its size, duration and codecs. The bytes are not returned: the user downloads the file from the 'Download export' button next to the agent status chip.",
    inputSchema: {
      type: "object",
      properties: {
        format: { type: "string", enum: FORMATS, description: "Container: mp4 (H.264/AAC) or webm (VP9/Opus). Default mp4." },
        quality: { type: "string", enum: QUALITIES, description: "Default high." },
        includeAudio: { type: "boolean", description: "Default true." },
      },
      additionalProperties: false,
    },
    readOnly: true,
    async run(input): Promise<ToolResult> {
      const args = (input ?? {}) as { format?: unknown; quality?: unknown; includeAudio?: unknown };
      const format = args.format ?? DEFAULT_EXPORT_OPTIONS.format;
      const quality = args.quality ?? DEFAULT_EXPORT_OPTIONS.quality;
      const includeAudio = args.includeAudio ?? DEFAULT_EXPORT_OPTIONS.includeAudio;
      if (!FORMATS.includes(format as ExportOptions["format"])) return fail(`'format' must be one of ${FORMATS.join(", ")}`);
      if (!QUALITIES.includes(quality as ExportOptions["quality"])) return fail(`'quality' must be one of ${QUALITIES.join(", ")}`);
      if (typeof includeAudio !== "boolean") return fail("'includeAudio' must be a boolean");
      if (running) return fail("An export is already running", "Wait for it to finish and call export_project again.");
      const { editor } = deps;
      if (!editor.hasProject) return fail("No project is open in the editor");
      running = true;
      try {
        editor.playback.pause();
        const result = await exportProject({
          doc: editor.getState().doc, getBlob: deps.runtime().getBlob,
          options: { format: format as ExportOptions["format"], quality: quality as ExportOptions["quality"], includeAudio },
        });
        const fileName = exportFileName(editor.getState().meta?.name ?? "export", result.extension);
        deps.onExport?.({ blob: result.blob, fileName });
        return {
          ok: true,
          summary: `Exported ${result.width}x${result.height}, ${result.durationSeconds.toFixed(2)}s, ${(result.blob.size / 1_000_000).toFixed(1)} MB. The user can download it from the editor.`,
          data: {
            fileName, mimeType: result.mimeType, bytes: result.blob.size, width: result.width, height: result.height,
            durationSeconds: result.durationSeconds, frameCount: result.frameCount, hasAudio: result.hasAudio,
            videoCodec: result.videoCodec, audioCodec: result.audioCodec,
          },
        };
      } finally {
        running = false;
      }
    },
  };
}

/** Tools that need the browser (decoding, canvas, export). Shared by the in-app agent and the MCP bridge. */
export function createPlatformTools(deps: PlatformToolDeps): AgentTool[] {
  return [renderFrameTool(deps), contactSheetTool(deps), analyzeMediaTool(deps), analyzeTimelineTool(deps), exportTool(deps)];
}

let cachedStore: AnalysisStore | null = null;

/** One lazily opened analysis cache for the whole page, shared by the in-app agent and the bridge. */
export function sharedAnalysisStore(): AnalysisStore {
  cachedStore ??= new IdbAnalysisStore();
  return cachedStore;
}
