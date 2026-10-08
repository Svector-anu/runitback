import { batch, insertElement } from "#/engine/commands";
import type { TimelineElement } from "#/engine/model";
import type { AnalysisProvider } from "#/engine/reference";
import {
  buildTemporalIndex, describeIndex, findMoments, momentsToTimelineRanges, rankMoments, summarizeIndex,
  type ClipPlacement, type Moment, type MomentQuery, type MomentSort, type TemporalIndex,
} from "#/engine/temporal";
import { canPlaceSpans, elementEnd } from "#/engine/timeline";
import { TICKS_PER_SECOND } from "#/engine/time";
import type { TranscriptStore } from "#/engine/transcript";
import { defineTool, ok, toSec, ToolError, type ToolEnv } from "./env";
import { buildPlanElements } from "./tools-reference";
import type { AgentTool, JsonSchema } from "./types";

/** Injected by the app layer: where finished analyses and transcripts come from. */
export interface TemporalDeps {
  analysis: AnalysisProvider;
  transcripts: TranscriptStore;
}

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;
const MAX_CUT_MOMENTS = 100;
const ms = (seconds: number): number => Math.round(seconds * 1000) / 1000;
const db = (value: number | null): number | null => (value === null ? null : Math.round(value * 10) / 10);
const secondsOf = (ticks: number): number => ticks / TICKS_PER_SECOND;

const SORTS: MomentSort[] = ["relevance", "time", "loudest", "quietest", "longest"];

type TaggedMoment = Moment & { assetId: string };

interface Placed {
  elementId: string;
  placement: ClipPlacement;
}

function placedClips(env: ToolEnv, assetId: string): Placed[] {
  return [...env.tracks.overlay, env.tracks.main, ...env.tracks.audio].flatMap((track) =>
    (track.elements as TimelineElement[]).flatMap((e): Placed[] => {
      if ((e.type !== "video" && e.type !== "audio") || e.mediaId !== assetId) return [];
      return [{
        elementId: e.id,
        placement: {
          startSeconds: secondsOf(e.startTime), durationSeconds: secondsOf(e.duration), trimStartSeconds: secondsOf(e.trimStart),
          rate: "retime" in e && e.retime ? e.retime.rate : 1,
        },
      }];
    }));
}

const ASSET_ID: JsonSchema = { type: "string", description: "Asset id from list_assets." };

export function createTemporalTools(deps: TemporalDeps): AgentTool[] {
  async function indexOf(env: ToolEnv, assetId: string, options: { lenient: boolean }): Promise<TemporalIndex | undefined> {
    const asset = env.editor.getAsset(assetId);
    if (!asset) throw new ToolError(`No asset with id "${assetId}".`, `Call list_assets. Known ids: ${env.doc.assets.map((a) => a.id).join(", ") || "(none)"}.`);
    if (asset.type !== "video" && asset.type !== "audio") throw new ToolError(`Asset "${assetId}" is ${asset.type === "image" ? "an image" : `a ${asset.type}`}, which has no timeline of its own.`, "Pass a video or audio asset.");
    let analysis;
    let transcript;
    try {
      [analysis, transcript] = await Promise.all([deps.analysis.get(assetId), deps.transcripts.get(assetId)]);
    } catch (error) {
      throw new ToolError(`Could not read what is known about "${assetId}": ${error instanceof Error ? error.message : String(error)}`, "Retry once; if it keeps failing, analyze_media the asset first.");
    }
    if (!analysis && !transcript) {
      if (options.lenient) return undefined;
      throw new ToolError(`Nothing is indexed for asset "${assetId}": it has no analysis and no transcript.`, "Call analyze_media (shots, loudness, silence) and, for speech, transcribe_asset, then retry.");
    }
    const lastWord = transcript?.words[transcript.words.length - 1];
    const duration = asset.duration !== undefined ? secondsOf(asset.duration) : analysis?.durationSeconds ?? lastWord?.endSeconds ?? 0;
    return buildTemporalIndex({ assetId, duration, ...(analysis ? { analysis } : {}), ...(transcript ? { transcript } : {}) });
  }

  const describe = defineTool<{ assetId: string }>({
    name: "describe_footage",
    description:
      "One compact picture of an asset's footage on a single SOURCE-time axis: its shots (from scene cuts) with loudness, silence share and word counts, the spoken sentences (with word indices), the longest silences, and the beat grid. Built from the asset's analysis and transcript; says which of the two is missing. Use find_moments to locate specific moments instead of re-analyzing. Read-only.",
    inputSchema: { type: "object", properties: { assetId: ASSET_ID }, required: ["assetId"] },
    readOnly: true,
    async run(input, env) {
      env.requireProject();
      const index = (await indexOf(env, input.assetId, { lenient: false })) as TemporalIndex;
      const onTimeline = placedClips(env, input.assetId).map((p) => ({ elementId: p.elementId, start: ms(p.placement.startSeconds), end: ms(p.placement.startSeconds + p.placement.durationSeconds) }));
      return ok(describeIndex(index), { ...summarizeIndex(index), onTimeline });
    },
  });

  const find = defineTool<{
    assetId?: string; allAssets?: boolean; text?: string; shot?: number; minLoudnessDb?: number; maxLoudnessDb?: number; silent?: boolean; speaking?: boolean;
    startSeconds?: number; endSeconds?: number; sort?: MomentSort; limit?: number;
  }>({
    name: "find_moments",
    description:
      "Find moments in footage by combining filters; all given filters must hold. What a moment is depends on the query: sentences that contain `text`; else silences for silent:true; else sentences for speaking:true; else whole shots. Filters: text (word or phrase, case and punctuation ignored), shot (index from describe_footage), minLoudnessDb/maxLoudnessDb (mean level of the moment, dBFS), silent / speaking (true keeps, false excludes), startSeconds/endSeconds (restrict to a SOURCE range; moments are clipped to it). sort: relevance (phrase matches, then time; default), time, loudest, quietest, longest. Times are SOURCE seconds; each result also lists where it plays on the timeline (elementId, timeline seconds) when the asset is placed. Pass assetId, or allAssets:true to search every video/audio asset that has an analysis or transcript. Pass the results to cut_to_moments to assemble them. Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        assetId: ASSET_ID,
        allAssets: { type: "boolean", description: "Search every video/audio asset in the project instead of one." },
        text: { type: "string", description: "Word or phrase that is said, e.g. 'budget'." },
        shot: { type: "integer", minimum: 0, description: "Only inside this shot index." },
        minLoudnessDb: { type: "number", description: "Mean level at least this loud, dBFS (e.g. -20)." },
        maxLoudnessDb: { type: "number", description: "Mean level at most this loud, dBFS." },
        silent: { type: "boolean", description: "true: only silent stretches; false: exclude them." },
        speaking: { type: "boolean", description: "true: only where someone speaks; false: exclude it." },
        startSeconds: { type: "number", minimum: 0, description: "Start of a SOURCE range to restrict to." },
        endSeconds: { type: "number", minimum: 0, description: "End of a SOURCE range to restrict to." },
        sort: { type: "string", enum: SORTS, description: "Ordering (default relevance)." },
        limit: { type: "integer", minimum: 1, maximum: MAX_LIMIT, description: `Most moments to return (default ${DEFAULT_LIMIT}).` },
      },
    },
    readOnly: true,
    async run(input, env) {
      env.requireProject();
      if ((input.assetId === undefined) === (input.allAssets !== true)) {
        throw new ToolError("Pass exactly one of assetId or allAssets:true.", "Use assetId for one asset (ids from list_assets), allAssets:true to search the whole project.");
      }
      if (input.startSeconds !== undefined && input.endSeconds !== undefined && input.endSeconds <= input.startSeconds) {
        throw new ToolError(`endSeconds (${input.endSeconds}) must be after startSeconds (${input.startSeconds}).`, "Give a source range with end > start, or omit one side.");
      }
      const limit = input.limit ?? DEFAULT_LIMIT;
      const query: MomentQuery = {
        ...(input.text === undefined ? {} : { text: input.text }),
        ...(input.shot === undefined ? {} : { shot: input.shot }),
        ...(input.minLoudnessDb === undefined ? {} : { minLoudnessDb: input.minLoudnessDb }),
        ...(input.maxLoudnessDb === undefined ? {} : { maxLoudnessDb: input.maxLoudnessDb }),
        ...(input.silent === undefined ? {} : { silent: input.silent }),
        ...(input.speaking === undefined ? {} : { speaking: input.speaking }),
        ...(input.startSeconds === undefined && input.endSeconds === undefined
          ? {}
          : { sourceRange: { startSeconds: input.startSeconds ?? 0, endSeconds: input.endSeconds ?? Number.POSITIVE_INFINITY } }),
        sort: input.sort ?? "relevance",
        limit: limit + 1,
      };

      const assetIds = input.assetId !== undefined
        ? [input.assetId]
        : env.doc.assets.filter((a) => a.type === "video" || a.type === "audio").map((a) => a.id);
      const found: TaggedMoment[] = [];
      const skipped: string[] = [];
      for (const assetId of assetIds) {
        const index = await indexOf(env, assetId, { lenient: input.allAssets === true });
        if (!index) {
          skipped.push(assetId);
          continue;
        }
        if (query.text !== undefined && !index.sources.transcript && input.allAssets !== true) {
          throw new ToolError(`Asset "${assetId}" has no transcript, so "${query.text}" cannot be searched.`, "Call transcribe_asset first, or search by loudness, silence and shots only.");
        }
        if (query.shot !== undefined && query.shot >= index.shots.length && input.allAssets !== true) {
          throw new ToolError(`Asset "${assetId}" has ${index.shots.length} shot(s); shot ${query.shot} does not exist.`, `Use a shot index from 0 to ${index.shots.length - 1} (see describe_footage).`);
        }
        for (const moment of findMoments(index, query)) found.push({ ...moment, assetId });
      }
      if (assetIds.length > 0 && skipped.length === assetIds.length) {
        throw new ToolError("None of the assets has an analysis or a transcript.", "Call analyze_media (and transcribe_asset for speech) on the assets you want to search.");
      }
      const ranked = rankMoments(found, query.sort ?? "relevance");
      const truncated = ranked.length > limit;
      const placements = new Map<string, Placed[]>();
      const moments = ranked.slice(0, limit).map((m) => {
        if (!placements.has(m.assetId)) placements.set(m.assetId, placedClips(env, m.assetId));
        const timeline = (placements.get(m.assetId) ?? []).flatMap((p) =>
          momentsToTimelineRanges({ moments: [m], placement: p.placement }).map((r) => ({ elementId: p.elementId, startSeconds: ms(r.startSeconds), endSeconds: ms(r.endSeconds) })));
        return {
          assetId: m.assetId, startSeconds: ms(m.startSeconds), endSeconds: ms(m.endSeconds), shotIndex: m.shotIndex,
          ...(m.text === undefined ? {} : { text: m.text }), loudnessDb: db(m.loudnessDb), reason: m.reason, ...(timeline.length > 0 ? { timeline } : {}),
        };
      });
      const lines = moments.map((m, i) =>
        `#${i + 1} ${m.assetId} ${m.startSeconds}s-${m.endSeconds}s (shot ${m.shotIndex}${m.loudnessDb === null ? "" : `, ${m.loudnessDb}dB`}) ${m.reason}${m.text === undefined ? "" : `: "${m.text}"`}`);
      const note = skipped.length > 0 ? ` Skipped (no analysis or transcript): ${skipped.join(", ")}.` : "";
      return ok(
        moments.length === 0 ? `No moments match.${note}` : `${moments.length} moment(s)${truncated ? ` (more exist; raise limit up to ${MAX_LIMIT} or narrow the filters)` : ""}, SOURCE seconds.${note}\n${lines.join("\n")}`,
        { unit: "source seconds", moments, truncated, skipped },
      );
    },
  });

  const cut = defineTool<{ moments: Array<{ assetId: string; startSeconds: number; endSeconds: number }>; startSeconds?: number }>({
    name: "cut_to_moments",
    description:
      "Build a sequence from chosen moments: each [startSeconds, endSeconds] SOURCE range (as returned by find_moments) becomes a video clip, placed back to back on the main track in the order given, starting at startSeconds (default: right after the last clip on the main track, or 0 when it is empty). Nothing is moved or rippled; fails without changes if the span is occupied or a range exceeds its source. Video assets only. One undo step. Times are SECONDS, snapped to the frame grid.",
    inputSchema: {
      type: "object",
      properties: {
        moments: {
          type: "array",
          items: {
            type: "object",
            properties: { assetId: ASSET_ID, startSeconds: { type: "number", minimum: 0 }, endSeconds: { type: "number", minimum: 0 } },
            required: ["assetId", "startSeconds", "endSeconds"],
          },
          description: `Ordered source ranges, at most ${MAX_CUT_MOMENTS}.`,
        },
        startSeconds: { type: "number", minimum: 0, description: "Timeline position of the first clip." },
      },
      required: ["moments"],
    },
    readOnly: false,
    run(input, env) {
      env.requireProject();
      if (input.moments.length === 0) throw new ToolError("moments is empty.", "Call find_moments first and pass its results.");
      if (input.moments.length > MAX_CUT_MOMENTS) throw new ToolError(`Too many moments (${input.moments.length}); the limit is ${MAX_CUT_MOMENTS}.`, "Cut in several calls or choose fewer moments.");
      const main = env.tracks.main;
      const mainEnd = (main.elements as TimelineElement[]).reduce((end, e) => Math.max(end, elementEnd(e)), 0);
      const startTicks = input.startSeconds === undefined ? mainEnd : env.snap(input.startSeconds);
      if (main.elements.length === 0 && startTicks > 0) {
        throw new ToolError("The main track is empty, so the sequence must start at 0.", "Omit startSeconds or pass 0.");
      }
      const shots = input.moments.map((m) => ({ assetId: m.assetId, in: m.startSeconds, out: m.endSeconds }));
      const elements = buildPlanElements({ shots, startTicks, env });
      const last = elements[elements.length - 1];
      if (!last) throw new ToolError("No clips could be built from the moments.", "Check the ranges with find_moments.");
      if (!canPlaceSpans(main, [{ start: startTicks, duration: elementEnd(last) - startTicks }])) {
        throw new ToolError(
          `The main track is occupied between ${toSec(startTicks)}s and ${toSec(elementEnd(last))}s.`,
          "Omit startSeconds to append after the existing clips (see get_timeline), or delete them first.",
        );
      }
      const mainId = main.id;
      const clips = env.atomically("Cut to moments", () => {
        env.editor.execute(batch("Cut to moments", elements.map((element) => insertElement({ element, placement: { mode: "explicit", trackId: mainId } }))));
        return elements.map((element, i) => {
          const landed = env.require(element.id);
          if (landed.element.startTime !== element.startTime || landed.track.id !== mainId) {
            throw new ToolError(
              `The main track is occupied or ordered such that clip ${i + 1} could not land at ${toSec(element.startTime)}s.`,
              "Start after the existing clips on the main track (omit startSeconds) or delete them first.",
            );
          }
          const moment = input.moments[i] as { assetId: string; startSeconds: number; endSeconds: number };
          return { elementId: element.id, assetId: moment.assetId, sourceStart: ms(moment.startSeconds), sourceEnd: ms(moment.endSeconds), start: toSec(element.startTime), end: toSec(elementEnd(element)) };
        });
      });
      return ok(`Placed ${clips.length} clip(s) back to back on the main track from ${toSec(startTicks)}s to ${toSec(elementEnd(last))}s.`, { clips, durationSeconds: toSec(env.editor.duration()) });
    },
  });

  return [describe, find, cut];
}
