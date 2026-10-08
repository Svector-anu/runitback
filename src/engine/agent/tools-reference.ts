import { analyzeTimelinePacing, trackInputsFromScene, type MediaAnalysis, type TimelineTrackInput } from "#/engine/analysis";
import { batch, insertElement } from "#/engine/commands";
import { buildMediaElement } from "#/engine/model";
import {
  buildStyleProfile, beatTimes, compareToProfile, describeStyleProfile,
  planCutsToProfile, timelineBeats, type AnalysisProvider, type StoredStyleProfile, type StyleProfile, type StyleProfileStore,
} from "#/engine/reference";
import { canPlaceSpans, elementEnd } from "#/engine/timeline";
import { TICKS_PER_SECOND, mediaTime } from "#/engine/time";
import { defineTool, ok, toSec, ToolError, type ToolEnv } from "./env";
import type { AgentTool, JsonSchema } from "./types";

/** Injected by the app layer: where profiles persist and where finished analyses come from. */
export interface ReferenceDeps {
  store: StyleProfileStore;
  provider: AnalysisProvider;
}

const MIN_SHOT_FLOOR_SECONDS = 0.2;
const SOURCE_EPSILON_SECONDS = 0.0005;
const ms = (seconds: number): number => Math.round(seconds * 1000) / 1000;

const PROFILE_ID: JsonSchema = { type: "string", description: "Profile id from list_style_profiles or save_style_profile." };

function slug(name: string): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return base === "" ? "style" : base;
}

export function createReferenceTools(deps: ReferenceDeps): AgentTool[] {
  async function requireAnalysis(assetId: string): Promise<MediaAnalysis> {
    const analysis = await deps.provider.get(assetId);
    if (analysis) return analysis;
    throw new ToolError(`No analysis is available for asset "${assetId}".`, "Analyze the asset first (the app's analyze_media tool), then retry.");
  }

  async function requireProfile(profileId: string): Promise<StoredStyleProfile> {
    const stored = await deps.store.get(profileId);
    if (stored) return stored;
    const known = (await deps.store.list()).map((e) => e.id);
    throw new ToolError(`No style profile with id "${profileId}".`, known.length > 0 ? `Known profiles: ${known.join(", ")}.` : "Create one with save_style_profile first.");
  }

  async function analysesOnTimeline(tracks: ReadonlyArray<TimelineTrackInput>): Promise<Map<string, MediaAnalysis>> {
    const ids = new Set(tracks.filter((t) => t.kind === "audio").flatMap((t) => t.clips.flatMap((c) => (c.mediaId === undefined ? [] : [c.mediaId]))));
    const found = new Map<string, MediaAnalysis>();
    for (const id of ids) {
      const analysis = await deps.provider.get(id);
      if (analysis) found.set(id, analysis);
    }
    return found;
  }

  const save = defineTool<{ name: string; assetIds: string[] }>({
    name: "save_style_profile",
    description:
      "Measure one or more already-analysed reference videos and save the result as a reusable style profile: shot-length distribution and rhythm class, cut density over time, how tightly cuts follow the beat, audio loudness shape/silence, colour tendencies. Measures pacing and signal statistics only; it does not understand what is shown. Requires analyses to exist for every assetId. Returns profileId and a compact description. Does not change the project.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Short label, e.g. 'fast travel montage'." },
        assetIds: { type: "array", items: { type: "string" }, description: "Reference asset ids (see list_assets); several are pooled into one profile." },
      },
      required: ["name", "assetIds"],
    },
    readOnly: true,
    async run(input, env) {
      if (input.assetIds.length === 0) throw new ToolError("assetIds is empty.", "Pass at least one analysed reference asset id.");
      const analyses: MediaAnalysis[] = [];
      for (const id of new Set(input.assetIds)) analyses.push(await requireAnalysis(id));
      let profile: StyleProfile;
      try {
        profile = buildStyleProfile(analyses);
      } catch (error) {
        throw new ToolError(error instanceof Error ? error.message : String(error), "Use reference assets that are videos with detected shots.");
      }
      const taken = new Set((await deps.store.list()).map((e) => e.id));
      const base = slug(input.name);
      let id = base;
      for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
      await deps.store.save({ id, name: input.name, createdAtMs: env.ctx.nowMs(), profile });
      const description = describeStyleProfile(profile);
      return ok(`Saved style profile "${id}".\n${description}`, { profileId: id, name: input.name, description });
    },
  });

  const get = defineTool<{ profileId: string }>({
    name: "get_style_profile",
    description: "Full measured style profile by id (numbers) plus its compact description. Read-only.",
    inputSchema: { type: "object", properties: { profileId: PROFILE_ID }, required: ["profileId"] },
    readOnly: true,
    async run(input) {
      const stored = await requireProfile(input.profileId);
      const description = describeStyleProfile(stored.profile);
      return ok(`Style profile "${stored.id}" (${stored.name}).\n${description}`, { profileId: stored.id, name: stored.name, description, profile: stored.profile });
    },
  });

  const list = defineTool<Record<string, never>>({
    name: "list_style_profiles",
    description: "Saved style profiles: id, name, rhythm class, median shot length in seconds, cuts per minute. Read-only.",
    inputSchema: { type: "object", properties: {} },
    readOnly: true,
    async run() {
      const profiles = (await deps.store.list()).map((e) => ({
        profileId: e.id, name: e.name, rhythm: e.profile.shots.rhythm, medianShotSeconds: ms(e.profile.shots.medianSeconds), cutsPerMinute: ms(e.profile.shots.cutsPerMinute),
        sourceCount: e.profile.sourceIds.length,
      }));
      return ok(profiles.length === 0 ? "No style profiles saved." : `${profiles.length} style profile(s).`, { profiles });
    },
  });

  const compare = defineTool<{ profileId: string }>({
    name: "compare_to_style",
    description:
      "Analyse the CURRENT timeline and compare it with a saved style profile. Returns measurable deltas (average/median shot length, cuts per minute, opening shot length, share of cuts on the beat when an audio clip with an analysed beat is on the timeline, text density, dead air), each with actual, target and withinTolerance, plus matchScore 0..1. Compares pacing numbers only, not content. Read-only.",
    inputSchema: { type: "object", properties: { profileId: PROFILE_ID }, required: ["profileId"] },
    readOnly: true,
    async run(input, env) {
      env.requireProject();
      const { profile, name } = await requireProfile(input.profileId);
      const tracks = trackInputsFromScene(env.tracks);
      const timeline = analyzeTimelinePacing(tracks);
      const videoClips = tracks.filter((t) => t.kind === "video").flatMap((t) => t.clips);
      if (videoClips.length === 0) throw new ToolError("The timeline has no video clips to compare.", "Add footage first (insert_media or apply_cut_plan).");
      const shotStarts = [...new Set(videoClips.map((c) => c.start))].sort((a, b) => a - b);
      const beats = timelineBeats({ tracks, analyses: await analysesOnTimeline(tracks) });
      const textClips = tracks.filter((t) => t.kind === "text").flatMap((t) => t.clips);
      const result = compareToProfile(timeline, profile, { shotStarts, beats, textClips, videoSeconds: Math.max(...videoClips.map((c) => c.end)) });
      const lines = result.deltas.map((d) => `${d.withinTolerance ? "OK" : "OFF"}: ${d.message}`);
      return ok(`Timeline vs "${name}" (match ${Math.round(result.matchScore * 100)}%):\n${lines.join("\n")}`, {
        profileId: input.profileId,
        matchScore: result.matchScore,
        deltas: result.deltas.map((d) => ({ ...d, actual: ms(d.actual), target: ms(d.target) })),
      });
    },
  });

  const planSchemaShot: JsonSchema = {
    type: "object",
    properties: {
      assetId: { type: "string" },
      in: { type: "number", minimum: 0, description: "Source in point, SECONDS." },
      out: { type: "number", minimum: 0, description: "Source out point, SECONDS." },
    },
    required: ["assetId", "in", "out"],
  };

  const plan = defineTool<{
    profileId: string; assetIds: string[]; targetDuration?: number; seed?: number; minShot?: number; maxShot?: number; beatAssetId?: string;
  }>({
    name: "plan_cuts_to_style",
    description:
      "Propose a rough cut of the given video assets whose shot lengths follow a saved style profile; cuts snap to beats when the reference cut to the beat and beats are known (beatAssetId = an analysed music asset placed at 0, or an analysed audio clip already on the timeline). Footage is used forward and in order, never reused or overrun. Deterministic for a seed. Does NOT edit the project: review `plan`, then pass it to apply_cut_plan. Shape only: it does not choose shots by content. Times in SECONDS.",
    inputSchema: {
      type: "object",
      properties: {
        profileId: PROFILE_ID,
        assetIds: { type: "array", items: { type: "string" }, description: "Video assets to draw footage from (see list_assets)." },
        targetDuration: { type: "number", minimum: 0.1, description: "Wanted length in SECONDS; default and cap = total footage length." },
        seed: { type: "integer", description: "Changes the arrangement; default 1." },
        minShot: { type: "number", minimum: 0.04, description: "Shortest shot in SECONDS; default the profile's shortest, at least 0.2." },
        maxShot: { type: "number", minimum: 0.04, description: "Longest shot in SECONDS; default the profile's longest." },
        beatAssetId: { type: "string", description: "Analysed audio asset whose beats to snap cuts to (assumed to start at timeline 0)." },
      },
      required: ["profileId", "assetIds"],
    },
    readOnly: true,
    async run(input, env) {
      env.requireProject();
      const { profile, name } = await requireProfile(input.profileId);
      if (input.assetIds.length === 0) throw new ToolError("assetIds is empty.", "Pass at least one video asset id from list_assets.");
      const sourceRanges = [...new Set(input.assetIds)].map((id) => {
        const asset = env.editor.getAsset(id);
        if (!asset) throw new ToolError(`No asset with id "${id}".`, `Call list_assets. Known ids: ${env.doc.assets.map((a) => a.id).join(", ") || "(none)"}.`);
        if (asset.type !== "video" || asset.duration === undefined) throw new ToolError(`Asset "${id}" is a ${asset.type}, not a video with a duration.`, "Pass video assets only.");
        return { assetId: id, start: 0, end: asset.duration / TICKS_PER_SECOND };
      });
      const minShot = input.minShot ?? Math.max(MIN_SHOT_FLOOR_SECONDS, profile.shots.quantiles[0] ?? 0);
      const maxShot = input.maxShot ?? Math.max(minShot, profile.shots.quantiles[profile.shots.quantiles.length - 1] ?? minShot);
      if (maxShot < minShot) throw new ToolError(`maxShot (${maxShot}s) is below minShot (${minShot}s).`, "Make maxShot >= minShot.");
      const tracks = trackInputsFromScene(env.tracks);
      const beats = input.beatAssetId !== undefined
        ? beatTimes(await requireAnalysis(input.beatAssetId))
        : timelineBeats({ tracks, analyses: await analysesOnTimeline(tracks) });
      const result = planCutsToProfile({ sourceRanges, profile, beats, minShot, maxShot, seed: input.seed ?? 1, targetDuration: input.targetDuration });
      if (result.shots.length === 0) throw new ToolError(result.notes.join(" ") || "No shots could be planned.", "Use longer footage, a smaller minShot, or a larger targetDuration.");
      const shots = result.shots.map((s) => ({ assetId: s.assetId, in: ms(s.in), out: Math.floor(s.out * 1000) / 1000 }));
      const planData = { startSeconds: 0, shots };
      const notes = [...result.notes];
      if (beats.length === 0 && profile.beatLock.beatsAvailable && profile.beatLock.score >= 0.5) notes.push("The reference cuts to the beat but no beats were supplied; pass beatAssetId to snap cuts.");
      return ok(
        `Planned ${shots.length} shots, ${ms(result.totalSeconds)}s in the style of "${name}"${result.beatSnapped ? `; ${result.snappedCuts} cuts snapped to beats` : ""}. Not applied: call apply_cut_plan with this plan.${notes.length > 0 ? ` Notes: ${notes.join(" ")}` : ""}`,
        { plan: planData, totalSeconds: ms(result.totalSeconds), shotCount: shots.length, beatSnapped: result.beatSnapped, snappedCuts: result.snappedCuts, notes },
      );
    },
  });

  const apply = defineTool<{ plan: { startSeconds?: number; shots: Array<{ assetId: string; in: number; out: number }> } }>({
    name: "apply_cut_plan",
    description:
      "Build the rough cut from a plan returned by plan_cuts_to_style: each shot becomes a video clip trimmed to its in/out, placed back to back on the main track starting at plan.startSeconds (default 0). Nothing is rippled or moved; fails without changes if the main track is occupied in that span or a shot exceeds its source. One undo step. Times in SECONDS, snapped to the frame grid.",
    inputSchema: {
      type: "object",
      properties: {
        plan: {
          type: "object",
          properties: {
            startSeconds: { type: "number", minimum: 0, description: "Where the first shot starts; default 0." },
            shots: { type: "array", items: planSchemaShot, description: "Ordered shots from plan_cuts_to_style." },
          },
          required: ["shots"],
        },
      },
      required: ["plan"],
    },
    readOnly: false,
    run(input, env) {
      env.requireProject();
      const { shots } = input.plan;
      if (shots.length === 0) throw new ToolError("plan.shots is empty.", "Call plan_cuts_to_style first.");
      const startTicks = env.snap(input.plan.startSeconds ?? 0);
      const elements = buildPlanElements({ shots, startTicks, env });
      const last = elements[elements.length - 1];
      if (!last) throw new ToolError("The plan produced no clips.", "Call plan_cuts_to_style first.");
      const spans = [{ start: startTicks, duration: elementEnd(last) - startTicks }];
      if (!canPlaceSpans(env.tracks.main, spans)) {
        throw new ToolError(
          `The main track is occupied between ${toSec(startTicks)}s and ${toSec(elementEnd(last))}s.`,
          "Set plan.startSeconds past the existing clips (see get_timeline) or delete them first.",
        );
      }
      const mainId = env.tracks.main.id;
      env.editor.execute(batch("Apply cut plan", elements.map((element) => insertElement({ element, placement: { mode: "explicit", trackId: mainId } }))));
      const clips = elements.map((e) => ({ elementId: e.id, assetId: "mediaId" in e ? e.mediaId : "", start: toSec(e.startTime), end: toSec(elementEnd(e)) }));
      return ok(`Placed ${clips.length} clips on the main track from ${toSec(startTicks)}s to ${toSec(elementEnd(last))}s.`, { clips, durationSeconds: toSec(env.editor.duration()) });
    },
  });

  return [save, get, list, compare, plan, apply];
}

export function buildPlanElements(input: {
  shots: ReadonlyArray<{ assetId: string; in: number; out: number }>; startTicks: number; env: ToolEnv;
}) {
  const { env } = input;
  let boundary = input.startTicks;
  let elapsed = 0;
  return input.shots.map((shot, index) => {
    const asset = env.editor.getAsset(shot.assetId);
    if (!asset) throw new ToolError(`Shot ${index + 1}: no asset with id "${shot.assetId}".`, `Call list_assets. Known ids: ${env.doc.assets.map((a) => a.id).join(", ") || "(none)"}.`);
    if (asset.type !== "video" || asset.duration === undefined) throw new ToolError(`Shot ${index + 1}: asset "${shot.assetId}" is a ${asset.type}, not a video.`, "Plans may only use video assets.");
    if (!(shot.out > shot.in)) throw new ToolError(`Shot ${index + 1}: out (${shot.out}s) must be after in (${shot.in}s).`, "Fix the shot's in/out.");
    if (shot.out > asset.duration / TICKS_PER_SECOND + SOURCE_EPSILON_SECONDS) {
      throw new ToolError(`Shot ${index + 1}: out ${shot.out}s is past the end of "${shot.assetId}" (${toSec(asset.duration)}s).`, "Keep out within the asset duration, or re-plan.");
    }
    elapsed += shot.out - shot.in;
    const start = boundary;
    const end = env.snapTicks(input.startTicks + Math.round(elapsed * TICKS_PER_SECOND));
    boundary = end;
    const duration = end - start;
    const trimStart = env.snapTicks(Math.round(shot.in * TICKS_PER_SECOND));
    const trimEnd = asset.duration - trimStart - duration;
    if (duration <= 0 || trimEnd < 0) {
      throw new ToolError(`Shot ${index + 1} (${shot.in}s-${shot.out}s of "${shot.assetId}") does not fit the source on the frame grid.`, "Leave at least a frame of margin to the source end, or re-plan.");
    }
    const base = buildMediaElement({ id: env.editor.newId(), startTime: mediaTime(start), asset });
    return { ...base, startTime: mediaTime(start), duration: mediaTime(duration), trimStart: mediaTime(trimStart), trimEnd: mediaTime(trimEnd) };
  });
}
