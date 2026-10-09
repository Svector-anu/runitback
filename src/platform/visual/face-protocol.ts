import type { FaceFrame } from "#/engine/face";
import type { ImagePixels } from "./protocol";

export interface FrameInput {
  /** Source time in seconds; strictly increasing across a backend's lifetime. */
  time: number;
  pixels: ImagePixels;
}

/** Detects faces in sampled frames. Boxes come back as fractions of each frame. */
export interface FaceBackend {
  detect(input: { frames: FrameInput[] }): Promise<FaceFrame[]>;
  dispose(): void;
}

export type FaceWorkerRequest = { type: "detect-faces"; id: number; frames: FrameInput[] };

export type FaceWorkerResponse =
  | { type: "result"; id: number; frames: FaceFrame[] }
  | { type: "error"; id: number; message: string };
