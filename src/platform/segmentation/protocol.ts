import type { ImagePixels } from "#/platform/visual/protocol";

export interface SegmentFrameInput {
  /** Source time in seconds; strictly increasing across a backend's lifetime. */
  time: number;
  pixels: ImagePixels;
}

export interface SegmentedFrame {
  time: number;
  width: number;
  height: number;
  /** Person confidence 0..255 per pixel, row-major. */
  data: Uint8Array;
}

/** Which bundled model to run: the square one for portrait footage, the 16:9 one for landscape. */
export type SegmenterModelId = "selfie_segmenter" | "selfie_segmenter_landscape";

export interface SegmentBackend {
  segment(input: { model: SegmenterModelId; frames: SegmentFrameInput[] }): Promise<SegmentedFrame[]>;
  dispose(): void;
}

export type SegmentWorkerRequest = { type: "segment"; id: number; model: SegmenterModelId; frames: SegmentFrameInput[] };

export type SegmentWorkerResponse =
  | { type: "result"; id: number; frames: SegmentedFrame[] }
  | { type: "error"; id: number; message: string };
