/** All times are seconds in SOURCE time of the asset. */

export const VISUAL_INDEX_VERSION = 1;

/**
 * Image embeddings of sampled frames of one video. Rows are L2-normalised, so the cosine similarity of a frame and a
 * normalised text embedding is their dot product. Embeddings from different models are not comparable.
 */
export interface VisualEmbeddings {
  version: typeof VISUAL_INDEX_VERSION;
  assetId: string;
  /** Model that produced the vectors, e.g. "Xenova/clip-vit-base-patch32". */
  model: string;
  dimensions: number;
  durationSeconds: number;
  /** Scene cuts known when the frames were sampled; they bound the span a frame stands for. */
  cuts: number[];
  /** Source time of each sampled frame, ascending. */
  times: number[];
  /** `times.length * dimensions` floats, row-major. */
  vectors: Float32Array;
}

/** Where finished embeddings live. The platform layer supplies a persistent implementation. */
export interface VisualStore {
  get(assetId: string): VisualEmbeddings | undefined | Promise<VisualEmbeddings | undefined>;
  save(embeddings: VisualEmbeddings): void | Promise<void>;
}

/** Embeds a text query into the same space as the frames. Implemented in the platform layer; the engine never loads a model. */
export interface VisualSearcher {
  /** Identifies the model, so embeddings made by another model are not compared against it. */
  readonly model: string;
  embedText(query: string): Promise<Float32Array>;
}

/** Samples frames of an asset and embeds them. Implemented in the platform layer. */
export interface VisualIndexer {
  index(input: { assetId: string; signal?: AbortSignal; onProgress?: (fraction: number) => void }): Promise<VisualEmbeddings>;
}

export interface ScoredFrame {
  /** Row in the embeddings. */
  index: number;
  timeSeconds: number;
  /** Cosine similarity, -1..1; CLIP-style models put real matches around 0.2-0.35. */
  score: number;
}

export interface FrameSpan {
  startSeconds: number;
  endSeconds: number;
}

export interface VisualMoment extends FrameSpan {
  /** Best frame score inside the moment. */
  score: number;
  /** Number of matching frames merged into it. */
  frames: number;
}

export function createMemoryVisualStore(): VisualStore {
  const entries = new Map<string, VisualEmbeddings>();
  return { get: (assetId) => entries.get(assetId), save: (e) => { entries.set(e.assetId, e); } };
}
