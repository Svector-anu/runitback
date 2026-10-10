import type { FaceBox } from "./types";

/** Anything with a start and an end in source seconds. */
export interface TimeSpan {
  startSeconds: number;
  endSeconds: number;
}

export type FaceRegion = "left" | "center" | "right";

export const FACE_REGIONS: ReadonlyArray<FaceRegion> = ["left", "center", "right"];

export const boxArea = (box: Pick<FaceBox, "width" | "height">): number => box.width * box.height;

export const boxCenterX = (box: Pick<FaceBox, "x" | "width">): number => box.x + box.width / 2;
export const boxCenterY = (box: Pick<FaceBox, "y" | "height">): number => box.y + box.height / 2;

/** Which third of the frame, left to right, the centre of the box lies in. */
export function regionOf(box: Pick<FaceBox, "x" | "width">): FaceRegion {
  const centre = boxCenterX(box);
  return centre < 1 / 3 ? "left" : centre < 2 / 3 ? "center" : "right";
}

/** Intersection over union of two boxes, 0 when they do not touch. */
export function iou(a: Pick<FaceBox, "x" | "y" | "width" | "height">, b: Pick<FaceBox, "x" | "y" | "width" | "height">): number {
  const width = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const height = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  if (width <= 0 || height <= 0) return 0;
  const inter = width * height;
  return inter / (boxArea(a) + boxArea(b) - inter);
}
