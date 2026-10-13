/** Per-asset person masks: 8-bit confidence (0 = background, 255 = person) at sampled source times. */
export const MASK_TRACK_VERSION = 1;

export interface MaskTrack {
  version: number;
  assetId: string;
  /** Model that produced the masks; masks from another model are stale. */
  model: string;
  /** Mask size in pixels; every frame has exactly `width * height` values. */
  width: number;
  height: number;
  /** Source seconds of each sampled frame, strictly increasing. */
  times: number[];
  frames: Uint8Array[];
  durationSeconds: number;
}

/** One mask at one instant, ready to rasterise. */
export interface MaskFrame {
  width: number;
  height: number;
  data: Uint8Array;
}

export interface MaskStore {
  get(assetId: string): Promise<MaskTrack | undefined>;
  save(track: MaskTrack): Promise<void>;
  delete(assetId: string): Promise<void>;
  assetIds(): Promise<string[]>;
}
