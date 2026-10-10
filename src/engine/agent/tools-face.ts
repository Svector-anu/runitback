import { batch, clearPathAnimationCommand, upsertKeyframeCommand, type Command } from "#/engine/commands";
import {
  FACE_REGIONS, faceFocusPath, findFaceMoments, focusAt, focusTransform, isUsableFaceDetections,
  type FaceDetections, type FaceIndexer, type FaceMomentSort, type FaceRegion, type FaceStore, type FocusPoint,
} from "#/engine/face";
import { PARAM, type TimelineElement } from "#/engine/model";
import type { AnalysisProvider } from "#/engine/reference";
import { buildTemporalIndex, momentsToTimelineRanges } from "#/engine/temporal";
import { TICKS_PER_SECOND } from "#/engine/time";
import { defineTool, ok, ToolError, type ToolEnv } from "./env";
import { animationPathFor } from "./params";
import { placedClips } from "./tools-temporal";
import type { AgentTool, JsonSchema } from "./types";

/** Injected by the app layer: where detections live, and optionally how to produce them and where scene cuts come from. */
export interface FaceDeps {
  faces: FaceStore;
  indexer?: FaceIndexer;
  /** Detector model whose output is accepted; detections from another model count as stale. Defaults to whatever is stored. */
  model?: string;
  /** Scene cuts make shots (describe_faces) and keep a sampled frame from standing for footage across a cut. */
  analysis?: AnalysisProvider;
}

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;
const MAX_SHOT_LINES = 12;
const MAX_KEYFRAMES = 200;
const ms = (seconds: number): number => Math.round(seconds * 1000) / 1000;
const SORTS: FaceMomentSort[] = ["time", "longest"];
const ASSET_ID: JsonSchema = { type: "string", description: "Video asset id from list_assets." };

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));
const percent = (ratio: number): number => Math.round(ratio * 100);

const TRANSFORM_PATHS = [PARAM.positionX, PARAM.positionY, PARAM.scaleX, PARAM.scaleY] as const;

export function createFaceTools(deps: FaceDeps): AgentTool[] {
  function requireVideo(env: ToolEnv, assetId: string): void {
    const asset = env.editor.getAsset(assetId);
    if (!asset) throw new ToolError(`No asset with id "${assetId}".`, `Call list_assets. Known ids: ${env.doc.assets.map((a) => a.id).join(", ") || "(none)"}.`);
    if (asset.type !== "video") throw new ToolError(`Asset "${assetId}" is ${asset.type === "image" ? "an image" : `an ${asset.type} file`}; faces are detected in video only.`, "Pass a video asset.");
  }

  async function usableFaces(assetId: string): Promise<{ detections?: FaceDetections; stale: boolean }> {
    let stored: FaceDetections | undefined;
    try {
      stored = await deps.faces.get(assetId);
    } catch (error) {
      throw new ToolError(`Could not read the face data of "${assetId}": ${messageOf(error)}`, "Retry once; if it keeps failing, tell the user face data is unavailable.");
    }
    if (!stored) return { stale: false };
    return isUsableFaceDetections(stored, deps.model ?? stored.model) ? { detections: stored, stale: false } : { stale: true };
  }

  const missingHint = deps.indexer ? "Call index_faces on the video, then retry." : "Ask the user to run face detection on the video, then retry.";

  async function requireFaces(assetId: string): Promise<FaceDetections> {
    const found = await usableFaces(assetId);
    if (found.detections) return found.detections;
    throw new ToolError(
      found.stale ? `The face data of "${assetId}" is outdated or from a different detector.` : `Asset "${assetId}" has no face data, so nothing is known about the faces in it.`,
      found.stale && deps.indexer ? "Call index_faces with force:true, then retry." : missingHint,
    );
  }

  async function sceneCuts(assetId: string): Promise<number[]> {
    try {
      return (await deps.analysis?.get(assetId))?.sceneCuts.map((c) => c.time) ?? [];
    } catch {
      return [];
    }
  }

  const index = deps.indexer
    ? defineTool<{ assetId: string; force?: boolean }>({
        name: "index_faces",
        description:
          "Detect faces in a video on-device (sampled frames, nothing uploaded) and save the result so find_face_moments, describe_faces and reframe_to_faces can use it. Reuses existing face data unless force:true. Slow for long video. Does not change the project.",
        inputSchema: { type: "object", properties: { assetId: ASSET_ID, force: { type: "boolean", description: "Detect again even if usable face data exists." } }, required: ["assetId"] },
        readOnly: true,
        async run(input, env) {
          env.requireProject();
          requireVideo(env, input.assetId);
          const existing = input.force ? { stale: false } : await usableFaces(input.assetId);
          let detections = existing.detections;
          if (!detections) {
            try {
              detections = await (deps.indexer as FaceIndexer).index({ assetId: input.assetId });
              await deps.faces.save(detections);
            } catch (error) {
              throw new ToolError(`Face detection failed: ${messageOf(error)}`, "Retry once; if it keeps failing, tell the user face detection is unavailable.");
            }
          }
          const withFaces = detections.frames.filter((f) => f.boxes.length > 0).length;
          return ok(`${existing.detections ? "Face data already existed" : "Detected faces"}: ${withFaces} of ${detections.frames.length} sampled frame(s) show a face.`, {
            assetId: input.assetId, frames: detections.frames.length, framesWithFaces: withFaces, model: detections.model, cached: existing.detections !== undefined,
          });
        },
      })
    : undefined;

  const find = defineTool<{
    assetId?: string; allAssets?: boolean; present?: boolean; minFaces?: number; maxFaces?: number; minSize?: number; region?: FaceRegion;
    minDurationSeconds?: number; startSeconds?: number; endSeconds?: number; sort?: FaceMomentSort; limit?: number;
  }>({
    name: "find_face_moments",
    description:
      "Find moments in video by the faces in them, from face data (needs it for the video; allAssets skips videos without). Filters, all must hold: present (default true: a face is visible; false: no qualifying face), minFaces / maxFaces (qualifying faces in a frame, present moments only), minSize (smallest face height as a fraction of the frame height, e.g. 0.25 for a close-up), region (left, center or right third of the frame, by face centre), minDurationSeconds, startSeconds/endSeconds (a SOURCE range). sort: time (default) or longest (longest continuous presence first; limit 1 for the single longest). Frames are sampled about every 2 s, so edges are approximate. Each result has SOURCE seconds and, for every clip of the asset that plays it, where it sits on the timeline. Pass the results to cut_to_moments to assemble them. Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        assetId: ASSET_ID,
        allAssets: { type: "boolean", description: "Search every video with face data instead of one." },
        present: { type: "boolean", description: "true (default): a face is visible; false: stretches without a qualifying face." },
        minFaces: { type: "integer", minimum: 1, description: "At least this many faces (present moments)." },
        maxFaces: { type: "integer", minimum: 1, description: "At most this many faces (present moments)." },
        minSize: { type: "number", minimum: 0, maximum: 1, description: "Smallest face height as a fraction of the frame height." },
        region: { type: "string", enum: [...FACE_REGIONS], description: "Where the face is: left, center or right third of the frame." },
        minDurationSeconds: { type: "number", minimum: 0, description: "Drop moments shorter than this." },
        startSeconds: { type: "number", minimum: 0, description: "Start of a SOURCE range to restrict to." },
        endSeconds: { type: "number", minimum: 0, description: "End of a SOURCE range to restrict to." },
        sort: { type: "string", enum: SORTS, description: "time (default) or longest." },
        limit: { type: "integer", minimum: 1, maximum: MAX_LIMIT, description: `Most moments to return (default ${DEFAULT_LIMIT}).` },
      },
    },
    readOnly: true,
    async run(input, env) {
      env.requireProject();
      if ((input.assetId === undefined) === (input.allAssets !== true)) {
        throw new ToolError("Pass exactly one of assetId or allAssets:true.", "Use assetId for one video (ids from list_assets), allAssets:true to search the whole project.");
      }
      if (input.present === false && (input.minFaces !== undefined || input.maxFaces !== undefined)) {
        throw new ToolError("minFaces / maxFaces describe faces that are present, so they cannot be combined with present:false.", "Drop them, or search present moments.");
      }
      if (input.minFaces !== undefined && input.maxFaces !== undefined && input.maxFaces < input.minFaces) {
        throw new ToolError(`maxFaces (${input.maxFaces}) is below minFaces (${input.minFaces}).`, "Give a range with maxFaces >= minFaces.");
      }
      if (input.startSeconds !== undefined && input.endSeconds !== undefined && input.endSeconds <= input.startSeconds) {
        throw new ToolError(`endSeconds (${input.endSeconds}) must be after startSeconds (${input.startSeconds}).`, "Give a source range with end > start, or omit one side.");
      }
      const limit = input.limit ?? DEFAULT_LIMIT;
      const assetIds = input.assetId !== undefined ? [input.assetId] : env.doc.assets.filter((a) => a.type === "video").map((a) => a.id);
      if (input.assetId !== undefined) requireVideo(env, input.assetId);

      const found: Array<{ assetId: string; detections: FaceDetections }> = [];
      const skipped: Array<{ assetId: string; reason: "no-face-data" | "stale-face-data" }> = [];
      for (const assetId of assetIds) {
        const usable = await usableFaces(assetId);
        if (usable.detections) found.push({ assetId, detections: usable.detections });
        else skipped.push({ assetId, reason: usable.stale ? "stale-face-data" : "no-face-data" });
      }
      if (found.length === 0) {
        if (input.assetId !== undefined) await requireFaces(input.assetId);
        throw new ToolError("None of the videos has face data.", missingHint);
      }

      const query = {
        ...(input.present === undefined ? {} : { present: input.present }),
        ...(input.minFaces === undefined ? {} : { minFaces: input.minFaces }),
        ...(input.maxFaces === undefined ? {} : { maxFaces: input.maxFaces }),
        ...(input.minSize === undefined ? {} : { minSize: input.minSize }),
        ...(input.region === undefined ? {} : { region: input.region }),
        ...(input.minDurationSeconds === undefined ? {} : { minDurationSeconds: input.minDurationSeconds }),
        ...(input.startSeconds === undefined && input.endSeconds === undefined
          ? {}
          : { sourceRange: { startSeconds: input.startSeconds ?? 0, endSeconds: input.endSeconds ?? Number.POSITIVE_INFINITY } }),
        sort: input.sort ?? "time",
        limit: Number.MAX_SAFE_INTEGER,
      };
      const all = [];
      for (const { assetId, detections } of found) {
        const cuts = await sceneCuts(assetId);
        for (const moment of findFaceMoments({ detections, query, cuts })) all.push({ ...moment, assetId });
      }
      const ordered = input.sort === "longest"
        ? all.sort((a, b) => (b.endSeconds - b.startSeconds) - (a.endSeconds - a.startSeconds) || a.assetId.localeCompare(b.assetId) || a.startSeconds - b.startSeconds)
        : all.sort((a, b) => a.assetId.localeCompare(b.assetId) || a.startSeconds - b.startSeconds);
      const truncated = ordered.length > limit;
      const placements = new Map<string, ReturnType<typeof placedClips>>();
      const moments = ordered.slice(0, limit).map((m) => {
        if (!placements.has(m.assetId)) placements.set(m.assetId, placedClips(env, m.assetId));
        const timeline = (placements.get(m.assetId) ?? []).flatMap((p) =>
          momentsToTimelineRanges({ moments: [m], placement: p.placement }).map((r) => ({ elementId: p.elementId, startSeconds: ms(r.startSeconds), endSeconds: ms(r.endSeconds) })));
        return {
          assetId: m.assetId, startSeconds: ms(m.startSeconds), endSeconds: ms(m.endSeconds), frames: m.frames,
          maxFaces: m.maxFaces, meanFaces: ms(m.meanFaces), largestSize: ms(m.largestSize), ...(timeline.length > 0 ? { timeline } : {}),
        };
      });
      const note = skipped.length > 0 ? ` Not searched (${skipped.map((s) => `${s.assetId}: ${s.reason}`).join(", ")}).` : "";
      const lines = moments.map((m, i) => `#${i + 1} ${m.assetId} ${m.startSeconds}s-${m.endSeconds}s (up to ${m.maxFaces} face(s), largest ${percent(m.largestSize)}% of frame height)`);
      return ok(
        moments.length === 0 ? `No moments match.${note}` : `${moments.length} moment(s)${truncated ? ` (more exist; raise limit up to ${MAX_LIMIT} or narrow the filters)` : ""}, SOURCE seconds.${note}\n${lines.join("\n")}`,
        { unit: "source seconds", moments, truncated, skipped },
      );
    },
  });

  const describe = defineTool<{ assetId: string }>({
    name: "describe_faces",
    description:
      "Compact per-shot summary of the faces in a video: for each shot (scene cuts when the video was analyzed, else one shot) how often a face is visible, the mean number of faces, the biggest face (height as a share of the frame) and where faces mostly sit (left, center, right). Needs face data. Read-only.",
    inputSchema: { type: "object", properties: { assetId: ASSET_ID }, required: ["assetId"] },
    readOnly: true,
    async run(input, env) {
      env.requireProject();
      requireVideo(env, input.assetId);
      const detections = await requireFaces(input.assetId);
      let analysis;
      try {
        analysis = await deps.analysis?.get(input.assetId);
      } catch {
        analysis = undefined;
      }
      const built = buildTemporalIndex({ assetId: input.assetId, duration: detections.durationSeconds, ...(analysis ? { analysis } : {}), faces: detections });
      const shots = built.shots.flatMap((shot) => (shot.faces ? [{ index: shot.index, startSeconds: ms(shot.startSeconds), endSeconds: ms(shot.endSeconds), ...shot.faces }] : []));
      const data = shots.map((s) => ({
        shot: s.index, startSeconds: s.startSeconds, endSeconds: s.endSeconds, framesSampled: s.framesSampled, presentRatio: s.presentRatio, meanFaces: s.meanCount,
        ...(s.largest ? { largestFaceHeight: ms(s.largest.box.height), largestFaceAt: ms(s.largest.t) } : {}),
        ...(s.dominantPosition ? { position: s.dominantPosition } : {}),
      }));
      const lines = data.slice(0, MAX_SHOT_LINES).map((s) =>
        `#${s.shot} ${s.startSeconds}s-${s.endSeconds}s: ${s.framesSampled === 0 ? "no frames sampled" : `face in ${percent(s.presentRatio)}% of ${s.framesSampled} frame(s), mean ${s.meanFaces}${s.largestFaceHeight === undefined ? "" : `, largest ${percent(s.largestFaceHeight)}% of frame height`}${s.position ? `, mostly ${s.position}` : ""}`}`);
      const more = data.length > MAX_SHOT_LINES ? [`... ${data.length - MAX_SHOT_LINES} more shot(s) in data`] : [];
      const cutsNote = analysis ? "" : " No scene analysis: the whole video is one shot.";
      return ok(`Faces in ${input.assetId} (${ms(detections.durationSeconds)}s, ${detections.frames.length} sampled frame(s), ${detections.model}). Times are SOURCE seconds.${cutsNote}\n${[...lines, ...more].join("\n")}`, {
        assetId: input.assetId, durationSeconds: ms(detections.durationSeconds), sampledFrames: detections.frames.length, model: detections.model, shots: data,
      });
    },
  });

  const reframe = defineTool<{ elementId: string; subject?: "largest" | "all"; zoom?: "auto" | "none" }>({
    name: "reframe_to_faces",
    description:
      "Auto-reframe a video clip so the speaker stays centred in the project canvas, e.g. a 16:9 interview in a 9:16 project (set the canvas first with set_project). Writes transform position and scale keyframes over the part of the source the clip plays, honouring trim and speed, from face data (needs it). The path is smoothed and ignores small movements so the frame does not jitter. subject: largest (default, follows one face) or all (keeps every face in view); zoom: auto (default, moves in on small faces) or none (the widest crop that fills the canvas). Replaces existing position and scale animation on the clip and sets scaleX and scaleY to the same value (non-uniform scaling is lost). One undo step.",
    inputSchema: {
      type: "object",
      properties: {
        elementId: { type: "string", description: "A video clip on the timeline." },
        subject: { type: "string", enum: ["largest", "all"], description: "Follow the largest face (default) or frame all faces." },
        zoom: { type: "string", enum: ["auto", "none"], description: "auto (default) zooms in on small faces; none never goes tighter than filling the canvas." },
      },
      required: ["elementId"],
    },
    readOnly: false,
    async run(input, env) {
      env.requireProject();
      const located = env.require(input.elementId);
      const element = located.element as TimelineElement;
      if (element.type !== "video") throw new ToolError(`Only video clips can be reframed, "${input.elementId}" is ${element.type === "image" ? "an image" : `a ${element.type} clip`}.`, "Pick a video clip (get_timeline lists them).");
      const assetId = element.mediaId;
      const asset = env.editor.getAsset(assetId);
      if (!asset?.width || !asset.height) throw new ToolError(`The size of asset "${assetId}" is unknown, so the crop cannot be computed.`, "Re-import the video or pick another clip.");
      const detections = await requireFaces(assetId);

      const canvas = env.doc.settings.canvasSize;
      const rate = element.retime?.rate ?? 1;
      const windowStart = element.trimStart / TICKS_PER_SECOND;
      const windowEnd = windowStart + (element.duration * rate) / TICKS_PER_SECOND;
      const inWindow = detections.frames.filter((f) => f.t >= windowStart && f.t <= windowEnd && f.boxes.length > 0).length;
      if (inWindow === 0) {
        const elsewhere = detections.frames.some((f) => f.boxes.length > 0);
        throw new ToolError(
          elsewhere ? `No face was detected in the part of the video this clip plays (${ms(windowStart)}s-${ms(windowEnd)}s of the source).` : `No face was detected anywhere in "${assetId}".`,
          elsewhere ? "Use find_face_moments to see where faces appear, or pick another clip." : "There is nothing to centre on; leave the framing as it is.",
        );
      }

      const path = faceFocusPath({
        detections, sourceAspect: asset.width / asset.height, targetAspect: canvas.width / canvas.height,
        ...(input.subject ? { subject: input.subject } : {}), ...(input.zoom ? { zoom: input.zoom } : {}),
      });
      const sampleTimes = keyframeTimes({ path, windowStart, windowEnd });
      const frames = new Map<number, { positionX: number; positionY: number; scale: number }>();
      for (const t of sampleTimes) {
        const focus = focusAt(path, t);
        if (!focus) continue;
        const local = Math.min(element.duration, Math.max(0, Math.round(((t - windowStart) / rate) * TICKS_PER_SECOND)));
        frames.set(local, focusTransform({ focus, source: { width: asset.width, height: asset.height }, canvas }));
      }

      const replaced = TRANSFORM_PATHS.filter((p) => element.animations?.[animationPathFor(element, p)] !== undefined);
      const commands: Command[] = replaced.map((p) => clearPathAnimationCommand({ ref: located.ref, path: animationPathFor(element, p), localTime: 0 }));
      for (const [time, f] of frames) {
        const values = [f.positionX, f.positionY, f.scale, f.scale];
        TRANSFORM_PATHS.forEach((p, i) => commands.push(upsertKeyframeCommand({ ref: located.ref, path: animationPathFor(element, p), time, value: values[i] as number })));
      }
      env.editor.execute(batch("Reframe to faces", commands));

      const scales = [...frames.values()].map((f) => f.scale);
      return ok(
        `Reframed ${input.elementId} to the face${input.subject === "all" ? "s" : ""}: ${frames.size} keyframe(s) each on position and scale, zoom ${ms(Math.min(...path.map((p) => p.zoom)))}-${ms(Math.max(...path.map((p) => p.zoom)))}x.${replaced.length > 0 ? " Replaced its earlier position/scale animation." : ""}`,
        {
          elementId: input.elementId, keyframes: frames.size, properties: [...TRANSFORM_PATHS], replacedAnimation: replaced,
          scaleRange: { min: ms(Math.min(...scales)), max: ms(Math.max(...scales)) }, sourceWindow: { startSeconds: ms(windowStart), endSeconds: ms(windowEnd) },
          facesFoundInWindow: inWindow,
        },
      );
    },
  });

  return index ? [index, find, describe, reframe] : [find, describe, reframe];
}

/** Source times that get a keyframe: both ends of what the clip plays and the path points between them (thinned to a cap). */
function keyframeTimes(input: { path: ReadonlyArray<FocusPoint>; windowStart: number; windowEnd: number }): number[] {
  const inside = input.path.map((p) => p.t).filter((t) => t > input.windowStart && t < input.windowEnd);
  const room = MAX_KEYFRAMES - 2;
  const stride = Math.max(1, Math.ceil(inside.length / room));
  return [input.windowStart, ...inside.filter((_, i) => i % stride === 0), input.windowEnd];
}
