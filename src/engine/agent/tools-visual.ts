import { momentsToTimelineRanges } from "#/engine/temporal";
import {
  DEFAULT_MIN_SCORE, DEFAULT_WITHIN_OF_BEST, frameSpans, isUsableEmbeddings, mergeHitsIntoMoments, rankByText, sortVisualMoments,
  type ScoredFrame, type VisualEmbeddings, type VisualIndexer, type VisualMoment, type VisualMomentSort, type VisualSearcher, type VisualStore,
} from "#/engine/visual";
import { defineTool, ok, ToolError, type ToolEnv } from "./env";
import { placedClips } from "./tools-temporal";
import type { AgentTool, JsonSchema } from "./types";

/** Injected by the app layer: where embeddings live, how to embed a query, and (optionally) how to index an asset. */
export interface VisualDeps {
  store: VisualStore;
  searcher: VisualSearcher;
  indexer?: VisualIndexer;
}

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;
const MAX_QUERY_CHARS = 200;
const ms = (seconds: number): number => Math.round(seconds * 1000) / 1000;
const score3 = (value: number): number => Math.round(value * 1000) / 1000;

const SORTS: VisualMomentSort[] = ["relevance", "time"];
const ASSET_ID: JsonSchema = { type: "string", description: "Video asset id from list_assets." };

const errorName = (error: unknown): string | undefined => (error instanceof Error ? error.name : undefined);
const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

type TaggedMoment = VisualMoment & { assetId: string };

/** Measured true matches start at 0.24 (docs/VISUAL_SEARCH.md); a best score under it looks like background. */
export const CONFIDENT_BEST_SCORE = 0.24;
/** A best score this high is a real match even when the footage is full of look-alike frames. */
export const STRONG_BEST_SCORE = 0.28;
/** How far the best frame must stand above the 5th best, otherwise nothing singles out the hit. */
export const MIN_TOP_MARGIN = 0.02;
const MARGIN_RANK = 5;

export interface SearchConfidence {
  confidence: "low" | "ok";
  /** Best score minus the 5th best, or null with fewer than five frames. */
  margin: number | null;
  /** Present when confidence is low: what to do about it. */
  hint?: string;
}

/** Judges one search from all frame scores (best first, across every searched asset): absolute level, then separation. */
export function searchConfidence(scoresBestFirst: ReadonlyArray<number>): SearchConfidence {
  const best = scoresBestFirst[0];
  if (best === undefined) return { confidence: "low", margin: null, hint: "No frames were scored." };
  const fifth = scoresBestFirst[MARGIN_RANK - 1];
  const margin = fifth === undefined ? null : score3(best - fifth);
  const verify = "Do not trust the times yet: render_frame at the midpoint of the top moment and compare it with the request; if it does not match, rephrase the query as a short description of the picture and search again.";
  if (best < CONFIDENT_BEST_SCORE) return { confidence: "low", margin, hint: `The best score ${score3(best)} is below ${CONFIDENT_BEST_SCORE}, the level of real matches. ${verify}` };
  if (margin !== null && margin < MIN_TOP_MARGIN && best < STRONG_BEST_SCORE) {
    return { confidence: "low", margin, hint: `The best frame (${score3(best)}) barely beats the 5th best (margin ${margin}, needs ${MIN_TOP_MARGIN}), so nothing singles out a match. ${verify}` };
  }
  return { confidence: "ok", margin };
}

export function createVisualTools(deps: VisualDeps): AgentTool[] {
  function requireVideo(env: ToolEnv, assetId: string): void {
    const asset = env.editor.getAsset(assetId);
    if (!asset) throw new ToolError(`No asset with id "${assetId}".`, `Call list_assets. Known ids: ${env.doc.assets.map((a) => a.id).join(", ") || "(none)"}.`);
    if (asset.type !== "video") throw new ToolError(`Asset "${assetId}" is ${asset.type === "image" ? "an image" : `an ${asset.type} file`}; only video can be searched visually.`, "Pass a video asset.");
  }

  async function usableEmbeddings(assetId: string): Promise<{ embeddings?: VisualEmbeddings; stale: boolean }> {
    const stored = await deps.store.get(assetId);
    if (!stored) return { stale: false };
    return isUsableEmbeddings(stored, deps.searcher.model) ? { embeddings: stored, stale: false } : { stale: true };
  }

  const index = deps.indexer
    ? defineTool<{ assetId: string; force?: boolean }>({
        name: "index_visuals",
        description:
          "Prepare a video for visual search: samples frames (one per shot plus one every few seconds) and embeds them with an on-device image model, saved so find_visual_moments can search them. Reuses an existing index unless force:true. Slow for long video; the first run downloads a model. Does not change the project.",
        inputSchema: {
          type: "object",
          properties: {
            assetId: ASSET_ID,
            force: { type: "boolean", description: "Index again even if an index from the current model exists." },
          },
          required: ["assetId"],
        },
        readOnly: true,
        async run(input, env) {
          env.requireProject();
          requireVideo(env, input.assetId);
          const existing = input.force ? { stale: false } : await usableEmbeddings(input.assetId);
          let embeddings = existing.embeddings;
          if (!embeddings) {
            try {
              embeddings = await (deps.indexer as VisualIndexer).index({ assetId: input.assetId });
            } catch (error) {
              const needsConsent = errorName(error) === "ConsentRequiredError";
              throw new ToolError(
                needsConsent ? messageOf(error) : `Visual indexing failed: ${messageOf(error)}`,
                needsConsent ? "Do not retry until the user confirms the download; then call index_visuals again." : "Retry once; if it keeps failing, tell the user visual search is unavailable.",
              );
            }
            await deps.store.save(embeddings);
          }
          return ok(`${existing.embeddings ? "Visual index already existed" : "Indexed"}: ${embeddings.times.length} frame(s), model ${embeddings.model}.`, {
            assetId: input.assetId, frames: embeddings.times.length, model: embeddings.model, durationSeconds: ms(embeddings.durationSeconds), cached: existing.embeddings !== undefined,
          });
        },
      })
    : undefined;

  const find = defineTool<{ query: string; assetId?: string; allAssets?: boolean; limit?: number; minScore?: number; sort?: VisualMomentSort }>({
    name: "find_visual_moments",
    description:
      "Find moments in video by what they LOOK like, from a plain-language description such as 'a dog', 'a whiteboard' or 'someone laughing'. Compares the description with sampled frames of the video (needs index_visuals first, allAssets skips videos without one). Consecutive matching frames merge into one moment. Each result has SOURCE seconds, a similarity score (about 0.2-0.35 for real matches; higher is better) and, for every clip of the asset that plays it, where it sits on the timeline. Frames are sampled about every 2 s and per shot, so edges are approximate: verify with render_frame if it matters. The data has confidence 'ok' or 'low' (low: the best frame is weak or barely beats the 5th best) with a hint; on low, render_frame at the top moment's midpoint and rephrase and search again before using it. Pass the results to cut_to_moments to assemble them. Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "What to look for, as a short phrase describing the picture." },
        assetId: ASSET_ID,
        allAssets: { type: "boolean", description: "Search every indexed video in the project instead of one." },
        limit: { type: "integer", minimum: 1, maximum: MAX_LIMIT, description: `Most moments to return (default ${DEFAULT_LIMIT}).` },
        minScore: { type: "number", minimum: -1, maximum: 1, description: `Lowest similarity that counts as a match (default ${DEFAULT_MIN_SCORE}).` },
        sort: { type: "string", enum: SORTS, description: "relevance (best score first, default) or time." },
      },
      required: ["query"],
    },
    readOnly: true,
    async run(input, env) {
      env.requireProject();
      const query = input.query.trim();
      if (!query) throw new ToolError("query is empty.", "Describe what to look for, e.g. 'a dog'.");
      if (query.length > MAX_QUERY_CHARS) throw new ToolError(`query is ${query.length} characters; the limit is ${MAX_QUERY_CHARS}.`, "Use a short description of the picture.");
      if ((input.assetId === undefined) === (input.allAssets !== true)) {
        throw new ToolError("Pass exactly one of assetId or allAssets:true.", "Use assetId for one video (ids from list_assets), allAssets:true to search the whole project.");
      }
      const limit = input.limit ?? DEFAULT_LIMIT;
      const minScore = input.minScore ?? DEFAULT_MIN_SCORE;

      const assetIds = input.assetId !== undefined ? [input.assetId] : env.doc.assets.filter((a) => a.type === "video").map((a) => a.id);
      if (input.assetId !== undefined) requireVideo(env, input.assetId);

      const indexed: VisualEmbeddings[] = [];
      const skipped: Array<{ assetId: string; reason: "not-indexed" | "stale-index" }> = [];
      for (const assetId of assetIds) {
        let found;
        try {
          found = await usableEmbeddings(assetId);
        } catch (error) {
          throw new ToolError(`Could not read the visual index of "${assetId}": ${messageOf(error)}`, "Retry once; if it keeps failing, index_visuals the asset again with force:true.");
        }
        if (found.embeddings) indexed.push(found.embeddings);
        else skipped.push({ assetId, reason: found.stale ? "stale-index" : "not-indexed" });
      }
      if (indexed.length === 0) {
        const first = skipped[0];
        throw new ToolError(
          input.assetId !== undefined
            ? `Asset "${input.assetId}" has ${first?.reason === "stale-index" ? "a visual index from a different model" : "no visual index"}.`
            : "None of the videos has a visual index.",
          deps.indexer ? "Call index_visuals on the video (force:true if the index is outdated), then retry." : "Ask the user to press Index visuals on the video in the Assets panel, then retry.",
        );
      }

      let textEmbedding: Float32Array;
      try {
        textEmbedding = await deps.searcher.embedText(query);
      } catch (error) {
        const needsConsent = errorName(error) === "ConsentRequiredError";
        throw new ToolError(
          needsConsent ? messageOf(error) : `Could not embed the query: ${messageOf(error)}`,
          needsConsent ? "Do not retry until the user confirms the download; then call find_visual_moments again." : "Retry once; if it keeps failing, tell the user visual search is unavailable.",
        );
      }

      const ranked: Array<{ embeddings: VisualEmbeddings; frames: ScoredFrame[] }> = indexed.map((embeddings) => ({ embeddings, frames: rankByText(embeddings, textEmbedding) }));
      const bestScore = Math.max(...ranked.map((r) => r.frames[0]?.score ?? Number.NEGATIVE_INFINITY));
      const floor = Math.max(minScore, bestScore - DEFAULT_WITHIN_OF_BEST);
      const found: TaggedMoment[] = ranked.flatMap(({ embeddings, frames }) => {
        const hits = frames.filter((f) => f.score >= floor);
        const spans = frameSpans({ times: embeddings.times, durationSeconds: embeddings.durationSeconds, cuts: embeddings.cuts });
        return mergeHitsIntoMoments({ spans, hits }).map((m) => ({ ...m, assetId: embeddings.assetId }));
      });

      const sorted = sortVisualMoments(found, input.sort ?? "relevance");
      const truncated = sorted.length > limit;
      const placements = new Map<string, ReturnType<typeof placedClips>>();
      const moments = sorted.slice(0, limit).map((m) => {
        if (!placements.has(m.assetId)) placements.set(m.assetId, placedClips(env, m.assetId));
        const timeline = (placements.get(m.assetId) ?? []).flatMap((p) =>
          momentsToTimelineRanges({ moments: [m], placement: p.placement }).map((r) => ({ elementId: p.elementId, startSeconds: ms(r.startSeconds), endSeconds: ms(r.endSeconds) })));
        return { assetId: m.assetId, startSeconds: ms(m.startSeconds), endSeconds: ms(m.endSeconds), score: score3(m.score), frames: m.frames, ...(timeline.length > 0 ? { timeline } : {}) };
      });

      const note = skipped.length > 0 ? ` Not searched (${skipped.map((s) => `${s.assetId}: ${s.reason}`).join(", ")}).` : "";
      const lines = moments.map((m, i) => `#${i + 1} ${m.assetId} ${m.startSeconds}s-${m.endSeconds}s score ${m.score} (${m.frames} frame${m.frames === 1 ? "" : "s"})`);
      const best = score3(bestScore);
      const confidence = searchConfidence(ranked.flatMap((r) => r.frames.map((f) => f.score)).sort((a, b) => b - a));
      const warning = confidence.hint ? ` LOW CONFIDENCE: ${confidence.hint}` : "";
      const summary = moments.length === 0
        ? `No frame looks like "${query}": the best similarity was ${best}, below ${minScore}.${note}${warning}`
        : `${moments.length} moment(s) for "${query}"${truncated ? ` (more exist; raise limit up to ${MAX_LIMIT})` : ""}, SOURCE seconds, best score ${best}, confidence ${confidence.confidence}.${note}${warning}\n${lines.join("\n")}`;
      return ok(summary, {
        unit: "source seconds", query, moments, truncated, bestScore: best, minScore, skipped,
        confidence: confidence.confidence, margin: confidence.margin, ...(confidence.hint ? { hint: confidence.hint } : {}),
      });
    },
  });

  return index ? [index, find] : [find];
}
