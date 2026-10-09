import { FACE_INDEX_VERSION, type FaceBox, type FaceDetections } from "./types";

const isFraction = (value: number): boolean => Number.isFinite(value) && value >= 0 && value <= 1;

const isUsableBox = (box: FaceBox): boolean =>
  isFraction(box.score) && Number.isFinite(box.x) && Number.isFinite(box.y) && box.width > 0 && box.height > 0;

/** True when the detections are well-formed (ascending frame times, sane boxes), of the current pipeline version and made by `model`. */
export function isUsableFaceDetections(detections: FaceDetections, model: string): boolean {
  if (detections.version !== FACE_INDEX_VERSION || detections.model !== model) return false;
  return detections.frames.every((frame, i) =>
    Number.isFinite(frame.t) && (i === 0 || frame.t >= (detections.frames[i - 1]?.t ?? 0)) && frame.boxes.every(isUsableBox));
}

/** Frames in which at least one face was found. */
export function framesWithFaces(detections: FaceDetections): number {
  return detections.frames.filter((frame) => frame.boxes.length > 0).length;
}
