export { createClipEngine, createLoadProgress, normalizeRows, type ClipEngineDeps, type ImageEncoder, type TextEncoder } from "./clip-engine";
export type { ClipBackend, EncodedBatch, ImagePixels } from "./protocol";
export { openVideoFrames, TARGET_SHORT_EDGE, type FrameSource } from "./frame-source";
export { createClipIndexer, DEFAULT_CLIP_MODEL, FRAME_BATCH_SIZE, NoVideoError, type ClipIndexerOptions, type Footage } from "./indexer";
export { isClipModelCached } from "./model-cache";
export { createClipSearcher, SEARCHER_IDLE_MS, type ClipSearcher, type ClipSearcherOptions } from "./searcher";
export { IdbVisualStore, VISUAL_DB_NAME } from "./store";
