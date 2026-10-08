import { VISUAL_INDEX_VERSION, type VisualEmbeddings } from "./types";

/** True when the embeddings are well-formed, of the current pipeline version and made by `model`. */
export function isUsableEmbeddings(embeddings: VisualEmbeddings, model: string): boolean {
  return embeddings.version === VISUAL_INDEX_VERSION
    && embeddings.model === model
    && embeddings.dimensions > 0
    && embeddings.vectors.length === embeddings.times.length * embeddings.dimensions;
}
