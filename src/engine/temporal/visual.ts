import { frameSpans, mergeHitsIntoMoments, rankByText, type VisualEmbeddings } from "#/engine/visual";
import type { TemporalEvent } from "./types";

/** Sampled-frame embeddings of an asset, optionally with one text query to turn them into labelled matches. */
export interface VisualTrackInput {
  embeddings: VisualEmbeddings;
  query?: { label: string; embedding: Float32Array; minScore?: number };
}

/**
 * Events for `tracks.visual`. Without a query: one unlabelled event per sampled frame, covering the span the frame stands
 * for. With a query: the matching stretches (touching matching frames merged), each labelled with the query and scored.
 */
export function visualEvents(input: VisualTrackInput): TemporalEvent[] {
  const { embeddings, query } = input;
  const spans = frameSpans({ times: embeddings.times, durationSeconds: embeddings.durationSeconds, cuts: embeddings.cuts });
  if (!query) return spans.filter((s) => s.endSeconds > s.startSeconds).map((s) => ({ startSeconds: s.startSeconds, endSeconds: s.endSeconds }));
  const hits = rankByText(embeddings, query.embedding, query.minScore === undefined ? {} : { minScore: query.minScore });
  return mergeHitsIntoMoments({ spans, hits }).map((m) => ({ startSeconds: m.startSeconds, endSeconds: m.endSeconds, label: query.label, score: m.score }));
}
