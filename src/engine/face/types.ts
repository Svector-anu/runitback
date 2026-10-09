/** All times are seconds in SOURCE time of the asset; all box coordinates are fractions (0..1) of the frame. */

export const FACE_INDEX_VERSION = 1;

export interface FaceBox {
  /** Left edge, fraction of frame width. */
  x: number;
  /** Top edge, fraction of frame height. */
  y: number;
  width: number;
  height: number;
  /** Detector confidence, 0..1. */
  score: number;
}

export interface FaceFrame {
  /** Source time of the sampled frame. */
  t: number;
  /** Empty when the frame was analysed and no face was found. */
  boxes: FaceBox[];
}

/** Face boxes of sampled frames of one video: the `tracks.face` source data. Frames are ascending in `t`. */
export interface FaceDetections {
  version: typeof FACE_INDEX_VERSION;
  assetId: string;
  /** Model that produced the boxes, e.g. "mediapipe/blaze_face_short_range". */
  model: string;
  durationSeconds: number;
  frames: FaceFrame[];
}

/** Where finished detections live. The platform layer supplies a persistent implementation. */
export interface FaceStore {
  get(assetId: string): FaceDetections | undefined | Promise<FaceDetections | undefined>;
  save(detections: FaceDetections): void | Promise<void>;
  delete(assetId: string): void | Promise<void>;
}

/** Samples frames of an asset and detects faces in them. Implemented in the platform layer. */
export interface FaceIndexer {
  index(input: { assetId: string; signal?: AbortSignal; onProgress?: (fraction: number) => void }): Promise<FaceDetections>;
}
