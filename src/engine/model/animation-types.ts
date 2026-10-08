import type { MediaTime } from "#/engine/time";

export type AnimationPath = string;
export type AnimationInterpolation = "linear" | "hold" | "bezier";
export type SegmentType = "step" | "linear" | "bezier";
export type TangentMode = "auto" | "aligned" | "broken" | "flat";

export interface CurveHandle {
  /** Time offset in ticks relative to the key (negative on the left handle). */
  dt: number;
  /** Value offset relative to the key. */
  dv: number;
}

export interface ScalarKey {
  id: string;
  /** Element-local time. */
  time: MediaTime;
  value: number;
  leftHandle?: CurveHandle;
  rightHandle?: CurveHandle;
  segmentToNext: SegmentType;
  tangentMode: TangentMode;
}

export interface DiscreteKey {
  id: string;
  time: MediaTime;
  value: boolean | string;
}

export type Extrapolation = "hold" | "linear";

export interface ScalarChannel {
  kind: "scalar";
  keys: ScalarKey[];
  extrapolation?: { before: Extrapolation; after: Extrapolation };
}

export interface DiscreteChannel {
  kind: "discrete";
  keys: DiscreteKey[];
}

export type Channel = ScalarChannel | DiscreteChannel;

/** A path animates either one channel, or a composite (e.g. colour r/g/b/a in linear light). */
export type AnimationBinding =
  | { kind: "channel"; channel: Channel }
  | { kind: "color"; channels: { r: ScalarChannel; g: ScalarChannel; b: ScalarChannel; a: ScalarChannel } };

export type ElementAnimations = Record<AnimationPath, AnimationBinding | undefined>;

export interface KeyframeRef {
  trackId: string;
  elementId: string;
  propertyPath: AnimationPath;
  keyframeId: string;
}
