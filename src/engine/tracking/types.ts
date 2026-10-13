/** An 8-bit greyscale picture at analysis resolution (a downscaled video frame). Row-major, `width * height` values. */
export interface LumaFrame {
  width: number;
  height: number;
  data: Uint8Array;
}

/** A point in analysis pixels. */
export interface Point2 {
  x: number;
  y: number;
}

export interface TrackSample extends Point2 {
  /** Source seconds of the frame. */
  t: number;
  /** Normalised cross-correlation of the match, -1..1 (1 = identical patch). */
  confidence: number;
  /** True while the target could not be found; the position then holds the last good one. */
  lost: boolean;
}

export interface MotionSample {
  t: number;
  /** Camera-induced content displacement since the first frame, in analysis pixels. */
  x: number;
  y: number;
  /** How many of the measuring blocks agreed on this frame's shift; 0 means the shift is a guess of "no movement". */
  support: number;
}
