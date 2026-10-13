import type { LumaFrame, MotionSample, Point2, TrackSample } from "#/engine/tracking";

export type TrackWorkerRequest =
  | { type: "track"; id: number; frames: LumaFrame[]; times: number[]; start: Point2 }
  | { type: "camera"; id: number; frames: LumaFrame[]; times: number[] };

export type TrackWorkerResponse =
  | { type: "track"; id: number; samples: TrackSample[] }
  | { type: "camera"; id: number; path: MotionSample[] }
  | { type: "error"; id: number; message: string };

export interface TrackingBackend {
  track(input: { frames: LumaFrame[]; times: number[]; start: Point2 }): Promise<TrackSample[]>;
  camera(input: { frames: LumaFrame[]; times: number[] }): Promise<MotionSample[]>;
  dispose(): void;
}
