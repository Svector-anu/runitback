import { batch, clearPathAnimationCommand, setElementParams, upsertKeyframeCommand, type Command } from "#/engine/commands";
import { PARAM, numberParam, type MediaAssetInfo, type TimelineElement, type VideoElement } from "#/engine/model";
import { computeVisualTransform, sourceUvToCanvasPoint } from "#/engine/render";
import { stabilize, thinSeries, type MotionSample, type TrackSample } from "#/engine/tracking";
import { TICKS_PER_SECOND, frameRateToFloat } from "#/engine/time";
import { elementEnd, resolveElementParams, sourceTimeAt } from "#/engine/timeline";
import { defineTool, ok, toSec, ToolError, type ToolEnv } from "./env";
import { animationPathFor } from "./params";
import type { AgentTool, JsonSchema } from "./types";

/** Injected by the app layer: motion analysis of a media file at the given SOURCE seconds (ascending). Positions come back in analysis pixels. */
export interface MotionDeps {
  track(input: { assetId: string; times: number[]; start: { u: number; v: number } }): Promise<{ width: number; height: number; samples: TrackSample[] }>;
  camera(input: { assetId: string; times: number[] }): Promise<{ width: number; height: number; path: MotionSample[] }>;
}

/** Same ceiling as the analyser (30 s at 30 fps). */
export const MAX_ANALYSED_FRAMES = 900;
const MAX_ANALYSIS_FPS = 30;
const POSITION_TOLERANCE_PX = 0.4;
const MAX_KEYFRAMES_PER_PATH = 400;
const LOST_WARNING_SHARE = 0.2;
const MIN_MEASURED_SHARE = 0.6;

interface Sampling { ticks: number[]; sourceSeconds: number[] }

/** Timeline ticks every 1/min(fps, 30) s over [from, to] (both ends included) and the source seconds each plays. */
function sampleRange(input: { env: ToolEnv; video: VideoElement; asset: MediaAssetInfo; from: number; to: number }): Sampling {
  const { video, asset } = input;
  const fps = Math.min(MAX_ANALYSIS_FPS, frameRateToFloat(input.env.fps));
  const step = TICKS_PER_SECOND / fps;
  const span = input.to - input.from;
  const count = Math.floor(span / step) + 1;
  if (count > MAX_ANALYSED_FRAMES) {
    throw new ToolError(`That range is ${toSec(span)} s, ${count} frames to analyse; the limit is ${MAX_ANALYSED_FRAMES} (about ${Math.floor(MAX_ANALYSED_FRAMES / fps)} s).`, "Pass a shorter start/end range, or split the clip first.");
  }
  const ticks = Array.from({ length: count }, (_, i) => Math.round(input.from + i * step));
  if ((ticks[ticks.length - 1] as number) < input.to - 1) ticks.push(input.to);
  const limit = asset.duration !== undefined ? asset.duration / TICKS_PER_SECOND - 0.001 : Number.POSITIVE_INFINITY;
  let previous = 0;
  const sourceSeconds = ticks.map((tick) => {
    const s = Math.min(limit, Math.max(0, sourceTimeAt({ trimStart: video.trimStart, clipTime: tick - video.startTime, retime: video.retime }) / TICKS_PER_SECOND));
    previous = Math.max(previous, s);
    return previous;
  });
  return { ticks, sourceSeconds };
}

function requireVideoClip(env: ToolEnv, id: string, role: string): { video: VideoElement; asset: MediaAssetInfo } {
  const located = env.require(id);
  const element = located.element as TimelineElement;
  if (element.type !== "video") throw new ToolError(`${role} "${id}" is ${element.type === "image" ? "an image" : `a ${element.type} clip`}; motion can only be measured in video.`, "Pick a video clip (get_timeline lists them).");
  const asset = env.editor.getAsset(element.mediaId);
  if (!asset?.width || !asset.height) throw new ToolError(`The size of asset "${element.mediaId}" is unknown.`, "Re-import the video or pick another clip.");
  return { video: element, asset };
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));
const round2 = (v: number): number => Math.round(v * 100) / 100;

function keyframeCommands(input: { ref: { trackId: string; elementId: string }; element: TimelineElement; key: string; series: Array<{ t: number; v: number }> }): Command[] {
  const path = animationPathFor(input.element, input.key);
  const thinned = thinSeries(input.series, POSITION_TOLERANCE_PX);
  if (thinned.length > MAX_KEYFRAMES_PER_PATH) throw new ToolError(`The motion needs ${thinned.length} keyframes on ${input.key}.`, "Use a shorter range.");
  return [
    ...(input.element.animations?.[path] !== undefined ? [clearPathAnimationCommand({ ref: input.ref, path, localTime: 0 })] : []),
    ...thinned.map((p) => upsertKeyframeCommand({ ref: input.ref, path, time: Math.max(0, Math.min(input.element.duration, Math.round(p.t))), value: p.v })),
  ];
}

export function createMotionTools(deps: MotionDeps): AgentTool[] {
  const trackPointTool = defineTool<{ videoElementId: string; targetElementId: string; x: number; y: number; start?: number; end?: number; offsetX?: number; offsetY?: number }>({
    name: "track_point",
    description:
      "Make a text, graphic or image clip follow a moving point in a video (motion tracking). Pick the point as `x`,`y` in the VIDEO's own picture at the first tracked moment: fractions 0-1, (0,0) top-left, (1,1) bottom-right, ideally a corner or detailed spot (flat areas and straight edges cannot be followed). The point is followed through the video on-device (no upload) and the target gets transform.positionX / positionY keyframes so its centre sits on the point (plus optional `offsetX`/`offsetY` px). The tracked range defaults to where the target and the video overlap on the timeline; `start`/`end` (SECONDS) narrow it. Translation only: a point that rotates, grows or is hidden is flagged lost (the target holds its last position); max 30 s per call. Replaces the target's earlier position keyframes. One undo step.",
    inputSchema: {
      type: "object",
      properties: {
        videoElementId: { type: "string", description: "The video clip that contains the moving point." },
        targetElementId: { type: "string", description: "The text, graphic or image clip that should follow it." },
        x: { type: "number", minimum: 0, maximum: 1 },
        y: { type: "number", minimum: 0, maximum: 1 },
        start: { type: "number", minimum: 0, description: "Timeline SECONDS where tracking starts (the point is at x,y here)." },
        end: { type: "number", minimum: 0, description: "Timeline SECONDS where tracking ends." },
        offsetX: { type: "number", description: "Extra px to the right of the point." },
        offsetY: { type: "number", description: "Extra px below the point." },
      },
      required: ["videoElementId", "targetElementId", "x", "y"],
    } satisfies JsonSchema,
    readOnly: false,
    async run(input, env) {
      env.requireProject();
      const { video, asset } = requireVideoClip(env, input.videoElementId, "Video clip");
      const targetLocated = env.require(input.targetElementId);
      const target = targetLocated.element as TimelineElement;
      if (target.id === video.id) throw new ToolError("The target must be a different clip from the tracked video.", "Pick a text, graphic or image clip.");
      if (target.type === "audio" || target.type === "effect") throw new ToolError(`A ${target.type} clip has no position to move.`, "Pick a text, graphic, image or video clip as the target.");
      if (!(input.x >= 0 && input.x <= 1 && input.y >= 0 && input.y <= 1)) throw new ToolError("x and y must be between 0 and 1.", "They are fractions of the video picture.");

      const from = Math.max(video.startTime, target.startTime, input.start === undefined ? 0 : env.snap(input.start));
      const to = Math.min(elementEnd(video) - 1, elementEnd(target) - 1, input.end === undefined ? Number.POSITIVE_INFINITY : env.snap(input.end));
      if (to - from < TICKS_PER_SECOND / MAX_ANALYSIS_FPS) throw new ToolError("The target and the video barely overlap on the timeline, so there is nothing to track.", "Move the target over the video, or widen start/end.");
      const sampling = sampleRange({ env, video, asset, from, to });
      let analysis;
      try {
        analysis = await deps.track({ assetId: video.mediaId, times: sampling.sourceSeconds, start: { u: input.x, v: input.y } });
      } catch (error) {
        throw new ToolError(`Tracking failed: ${messageOf(error)}`, "Pick a detailed corner of something that stays visible, or try a shorter range.");
      }

      const canvas = env.doc.settings.canvasSize;
      const seriesX: Array<{ t: number; v: number }> = [], seriesY: Array<{ t: number; v: number }> = [];
      analysis.samples.forEach((sample, i) => {
        const tick = sampling.ticks[i] as number;
        const params = resolveElementParams(video, tick - video.startTime);
        const transform = computeVisualTransform({ canvas, sourceWidth: asset.width as number, sourceHeight: asset.height as number, params });
        const point = sourceUvToCanvasPoint({ transform, uv: { u: sample.x / (analysis.width - 1), v: sample.y / (analysis.height - 1) } });
        seriesX.push({ t: tick - target.startTime, v: round2(point.x - canvas.width / 2 + (input.offsetX ?? 0)) });
        seriesY.push({ t: tick - target.startTime, v: round2(point.y - canvas.height / 2 + (input.offsetY ?? 0)) });
      });
      const commands = [
        ...keyframeCommands({ ref: targetLocated.ref, element: target, key: PARAM.positionX, series: seriesX }),
        ...keyframeCommands({ ref: targetLocated.ref, element: target, key: PARAM.positionY, series: seriesY }),
      ];
      env.editor.execute(batch("Track point", commands));

      const lost = analysis.samples.filter((s) => s.lost).length;
      const lostShare = lost / analysis.samples.length;
      const warning = lostShare > LOST_WARNING_SHARE ? ` The point was lost in ${Math.round(lostShare * 100)}% of the frames (hidden, left the frame or changed too much); the target holds still there.` : "";
      return ok(`${target.id} now follows the point over ${analysis.samples.length} frames (${toSec(from)}s-${toSec(to)}s).${warning}`, {
        targetElementId: target.id, framesTracked: analysis.samples.length, lostFrames: lost, startSeconds: toSec(from), endSeconds: toSec(to),
        keyframes: { positionX: thinSeries(seriesX, POSITION_TOLERANCE_PX).length, positionY: thinSeries(seriesY, POSITION_TOLERANCE_PX).length },
        meanConfidence: round2(analysis.samples.reduce((s, p) => s + p.confidence, 0) / analysis.samples.length),
      });
    },
  });

  const stabilizeTool = defineTool<{ elementId: string; smoothness?: number; maxShiftPercent?: number }>({
    name: "stabilize_clip",
    description:
      "Smooth out camera shake in a video clip. Measures the camera's translation frame to frame on-device (no upload), smooths it, and counter-moves the clip with transform.positionX / positionY keyframes, zooming in just enough (a static scale increase) to hide the moved edges. `smoothness` is the smoothing span in SECONDS (default 0.5; larger removes slower wobble but also real pans); `maxShiftPercent` (default 8) caps how far the picture may move as a percentage of its size. Translation only: it does not fix rotation, zoom wobble or rolling-shutter wobble, and it cannot tell shake from intentional motion beyond the smoothing span. Use on one continuous shot (cuts confuse it); max 30 s per call. Replaces the clip's earlier position keyframes. One undo step.",
    inputSchema: {
      type: "object",
      properties: {
        elementId: { type: "string" },
        smoothness: { type: "number", minimum: 0.1, maximum: 3, description: "Smoothing span in SECONDS (default 0.5)." },
        maxShiftPercent: { type: "number", minimum: 1, maximum: 20, description: "Largest counter-move as a percent of the picture (default 8)." },
      },
      required: ["elementId"],
    } satisfies JsonSchema,
    readOnly: false,
    async run(input, env) {
      env.requireProject();
      const located = env.require(input.elementId);
      const { video, asset } = requireVideoClip(env, input.elementId, "Clip");
      const smoothness = input.smoothness ?? 0.5;
      const maxFraction = (input.maxShiftPercent ?? 8) / 100;
      const fps = Math.min(MAX_ANALYSIS_FPS, frameRateToFloat(env.fps));
      const from = video.startTime;
      const to = elementEnd(video) - 1;
      const sampling = sampleRange({ env, video, asset, from, to });
      let analysis;
      try {
        analysis = await deps.camera({ assetId: video.mediaId, times: sampling.sourceSeconds });
      } catch (error) {
        throw new ToolError(`Motion analysis failed: ${messageOf(error)}`, "Retry once; if it keeps failing, tell the user stabilisation is unavailable for this clip.");
      }
      const result = stabilize({ path: analysis.path, sigmaSamples: smoothness * fps });
      if (result.measuredShare < MIN_MEASURED_SHARE) {
        throw new ToolError(`The camera motion could only be measured in ${Math.round(result.measuredShare * 100)}% of the frames (too little detail, blur, or cuts), so nothing was changed.`, "Stabilisation needs textured, in-focus footage from one continuous shot.");
      }

      const canvas = env.doc.settings.canvasSize;
      const seriesX: Array<{ t: number; v: number }> = [], seriesY: Array<{ t: number; v: number }> = [];
      let maxX = 0, maxY = 0, sumSquares = 0, smallestWidth = Number.POSITIVE_INFINITY, smallestHeight = Number.POSITIVE_INFINITY;
      result.corrections.forEach((c, i) => {
        const tick = sampling.ticks[i] as number;
        const params = resolveElementParams(video, tick - video.startTime);
        const transform = computeVisualTransform({ canvas, sourceWidth: asset.width as number, sourceHeight: asset.height as number, params });
        const toCanvas = transform.width / analysis.width;
        const clampedX = Math.max(-maxFraction * transform.width, Math.min(maxFraction * transform.width, c.x * toCanvas));
        const clampedY = Math.max(-maxFraction * transform.height, Math.min(maxFraction * transform.height, c.y * toCanvas));
        maxX = Math.max(maxX, Math.abs(clampedX));
        maxY = Math.max(maxY, Math.abs(clampedY));
        smallestWidth = Math.min(smallestWidth, transform.width);
        smallestHeight = Math.min(smallestHeight, transform.height);
        sumSquares += clampedX * clampedX + clampedY * clampedY;
        const base = { x: numberParam(params, PARAM.positionX, 0), y: numberParam(params, PARAM.positionY, 0) };
        seriesX.push({ t: tick - video.startTime, v: round2(base.x + clampedX) });
        seriesY.push({ t: tick - video.startTime, v: round2(base.y + clampedY) });
      });
      const zoom = Math.max(1 + (2 * maxX) / smallestWidth, 1 + (2 * maxY) / smallestHeight) + 0.01;
      const scaleAnimated = [PARAM.scaleX, PARAM.scaleY].some((k) => video.animations?.[k] !== undefined);
      const commands: Command[] = [
        ...keyframeCommands({ ref: located.ref, element: video, key: PARAM.positionX, series: seriesX }),
        ...keyframeCommands({ ref: located.ref, element: video, key: PARAM.positionY, series: seriesY }),
        ...(scaleAnimated ? [] : [setElementParams({
          refs: [located.ref], label: "Stabilise zoom",
          params: {
            [PARAM.scaleX]: round2000(numberParam(video.params, PARAM.scaleX, 1) * zoom),
            [PARAM.scaleY]: round2000(numberParam(video.params, PARAM.scaleY, 1) * zoom),
          },
        })]),
      ];
      env.editor.execute(batch("Stabilise", commands));
      const rms = Math.sqrt(sumSquares / (2 * result.corrections.length));
      return ok(
        `Stabilised ${video.id}: counter-moved by up to ${round2(Math.max(maxX, maxY))} px (RMS ${round2(rms)} px)${scaleAnimated ? "; its scale is animated, so the zoom to hide the edges was NOT applied and borders may show" : `, zoomed ${round2((zoom - 1) * 100)}% to hide the edges`}.`,
        {
          elementId: video.id, frames: result.corrections.length, maxShiftPx: { x: round2(maxX), y: round2(maxY) }, rmsShiftPx: round2(rms),
          zoomPercent: scaleAnimated ? 0 : round2((zoom - 1) * 100), measuredShare: round2(result.measuredShare), smoothnessSeconds: smoothness,
          keyframes: { positionX: thinSeries(seriesX, POSITION_TOLERANCE_PX).length, positionY: thinSeries(seriesY, POSITION_TOLERANCE_PX).length },
        },
      );
    },
  });

  return [trackPointTool, stabilizeTool];
}

const round2000 = (v: number): number => Math.round(v * 1000) / 1000;
