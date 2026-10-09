import type { FaceBox, FaceFrame } from "#/engine/face";
import type { FrameInput } from "./face-protocol";

/** A detector for one frame; `timestampMs` is strictly increasing, as the video running mode requires. */
export type FrameDetector = (input: { pixels: FrameInput["pixels"]; timestampMs: number }) => Promise<FaceBox[]>;

export interface FaceEngineDeps {
  loadDetector(): Promise<FrameDetector>;
}

export interface PixelBox {
  originX: number;
  originY: number;
  width: number;
  height: number;
}

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));

/** Pixel box to frame fractions, clipped to the frame; boxes that end up empty are dropped by the caller. */
export function toFractionBox(input: { box: PixelBox; score: number; frameWidth: number; frameHeight: number }): FaceBox {
  const { box, score, frameWidth, frameHeight } = input;
  const left = clamp01(box.originX / frameWidth);
  const top = clamp01(box.originY / frameHeight);
  const right = clamp01((box.originX + box.width) / frameWidth);
  const bottom = clamp01((box.originY + box.height) / frameHeight);
  return { x: left, y: top, width: right - left, height: bottom - top, score: clamp01(score) };
}

/** Model-agnostic core, shared by the worker and by tests (which inject a fake detector). The detector loads once. */
export function createFaceEngine(deps: FaceEngineDeps): { detect(input: { frames: FrameInput[] }): Promise<FaceFrame[]> } {
  let detector: Promise<FrameDetector> | undefined;
  let lastTimestampMs = -1;
  return {
    async detect({ frames }) {
      if (!detector) {
        detector = deps.loadDetector();
        detector.catch(() => { detector = undefined; });
      }
      const detect = await detector;
      const out: FaceFrame[] = [];
      for (const frame of frames) {
        lastTimestampMs = Math.max(lastTimestampMs + 1, Math.round(frame.time * 1000));
        const boxes = await detect({ pixels: frame.pixels, timestampMs: lastTimestampMs });
        out.push({ t: frame.time, boxes: boxes.filter((box) => box.width > 0 && box.height > 0) });
      }
      return out;
    },
  };
}
