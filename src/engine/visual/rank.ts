import type { ScoredFrame, VisualEmbeddings } from "./types";
import { dotAt, normalize } from "./vectors";

/** Real CLIP matches sit around 0.25-0.35 cosine similarity and unrelated frames around 0.15-0.22; below this a frame is not "about" the query. */
export const DEFAULT_MIN_SCORE = 0.22;
/** Frames more than this below the best match are the haze of weak similarities every query has, not further matches. */
export const DEFAULT_WITHIN_OF_BEST = 0.04;

export interface RankOptions {
  /** Most frames to return (default: all that pass the filters). */
  limit?: number;
  /** Drop frames scoring below this cosine similarity. */
  minScore?: number;
  /** Drop frames scoring more than this below the best one; separates the real matches from a uniform haze of weak ones. */
  withinOfBest?: number;
}

/** Cosine similarity of every frame to the text embedding, in frame order. Throws when the dimensions differ. */
export function scoreFrames(embeddings: VisualEmbeddings, textEmbedding: Float32Array): number[] {
  if (textEmbedding.length !== embeddings.dimensions) {
    throw new Error(`Text embedding has ${textEmbedding.length} dimensions but the frames have ${embeddings.dimensions}; they come from different models`);
  }
  const text = normalize(textEmbedding);
  return embeddings.times.map((_, row) => dotAt(text, embeddings.vectors, row * embeddings.dimensions));
}

const byScoreThenTime = (a: ScoredFrame, b: ScoredFrame): number => b.score - a.score || a.timeSeconds - b.timeSeconds;

/** Frames ordered by similarity to the text embedding, best first; ties fall back to time so output is deterministic. */
export function rankByText(embeddings: VisualEmbeddings, textEmbedding: Float32Array, options: RankOptions = {}): ScoredFrame[] {
  const scores = scoreFrames(embeddings, textEmbedding);
  const ranked = scores
    .map((score, index): ScoredFrame => ({ index, timeSeconds: embeddings.times[index] ?? 0, score }))
    .filter((frame) => options.minScore === undefined || frame.score >= options.minScore)
    .sort(byScoreThenTime);
  const best = ranked[0]?.score;
  const kept = options.withinOfBest === undefined || best === undefined ? ranked : ranked.filter((f) => f.score >= best - (options.withinOfBest as number));
  return options.limit === undefined ? kept : kept.slice(0, Math.max(0, options.limit));
}
