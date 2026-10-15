import type { TransitionType } from "#/engine/model";

/** Which side of the cut a layer is on: the clip being left, or the clip being entered. */
export type TransitionRole = "out" | "in";

/** How one clip is drawn at a point in a transition. Plain numbers so preview, export and tests share the maths. */
export interface LayerTransition {
  type: TransitionType;
  role: TransitionRole;
  /** Eased 0..1 across the whole transition: 0 = only the outgoing clip, 1 = only the incoming clip. */
  progress: number;
}

/** One horizontal slice of a glitching frame: rows `from`..`to` (fractions of the height) slide sideways by `shiftX` (fraction of the width). */
export interface GlitchBand { from: number; to: number; shiftX: number }

export interface GlitchLook {
  bands: GlitchBand[];
  /** Red and blue channels are pulled apart by this much, as a fraction of the width. */
  split: number;
}

export interface TransitionLook {
  /** Multiplies the layer's opacity. */
  alpha: number;
  /** Horizontal shift as a fraction of the canvas width. */
  shiftX: number;
  /** Scale about the clip's own centre. */
  scale: number;
  /** 0..1 blend toward black, applied to the clip's own pixels. */
  darkness: number;
  /** Visible horizontal span as fractions of the canvas width (everything outside is cut away); null = unclipped. */
  revealX: { from: number; to: number } | null;
  /** 0..1 blur strength, as a share of `TRANSITION_BLUR_INTENSITY` (the blur effect's own scale). */
  blur: number;
  /** 0..1 blend toward white, applied to the clip's own pixels. */
  lightness: number;
  glitch: GlitchLook | null;
}

/** Blur effect intensity (0-100 scale) a blur transition reaches at full strength. */
export const TRANSITION_BLUR_INTENSITY = 60;
export const GLITCH_BAND_COUNT = 12;
/** The glitch picture changes this many times across one transition, so it stutters instead of swimming. */
export const GLITCH_STEPS = 14;
const GLITCH_MAX_SHIFT = 0.09;
const GLITCH_MAX_SPLIT = 0.014;

/** Deterministic hash to 0..1, so a frame always glitches the same way in preview, export and tests. */
function hash01(a: number, b: number): number {
  let h = Math.imul(a + 1, 0x9e3779b1) ^ Math.imul(b + 1, 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
  return ((h ^ (h >>> 15)) >>> 0) / 0xffffffff;
}

/** Slices and channel split for a glitch at eased `progress`: strongest mid-transition, gone at both ends. */
export function glitchLook(progress: number): GlitchLook | null {
  const p = clamp01(progress);
  const strength = Math.sin(Math.PI * p);
  if (strength <= 0.001) return null;
  const step = Math.floor(p * GLITCH_STEPS);
  const edges = Array.from({ length: GLITCH_BAND_COUNT - 1 }, (_, i) => hash01(step, 100 + i)).sort((a, b) => a - b);
  const bounds = [0, ...edges, 1];
  const bands = bounds.slice(0, -1).map((from, i): GlitchBand => {
    const active = hash01(step, 200 + i) < 0.6;
    const direction = hash01(step, 300 + i) < 0.5 ? -1 : 1;
    return { from, to: bounds[i + 1] as number, shiftX: active ? direction * GLITCH_MAX_SHIFT * strength * (0.3 + 0.7 * hash01(step, 400 + i)) : 0 };
  });
  return { bands, split: GLITCH_MAX_SPLIT * strength };
}

export function easeTransition(t: number): number {
  const x = Math.min(1, Math.max(0, t));
  return x * x * (3 - 2 * x);
}

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));

/** Transitions that show one clip per half instead of overlapping the two. */
const CUT_AT_MIDPOINT: ReadonlySet<TransitionType> = new Set<TransitionType>(["fade-black", "flash", "glitch"]);

/** False when the layer contributes nothing at this progress (fade-through-black, flash and glitch show one clip per half). */
export function isTransitionLayerVisible(t: LayerTransition): boolean {
  if (!CUT_AT_MIDPOINT.has(t.type)) return true;
  return t.role === "out" ? t.progress < 0.5 : t.progress >= 0.5;
}

export function transitionLook(t: LayerTransition): TransitionLook {
  const p = clamp01(t.progress);
  const incoming = t.role === "in";
  const look: TransitionLook = { alpha: 1, shiftX: 0, scale: 1, darkness: 0, revealX: null, blur: 0, lightness: 0, glitch: null };
  switch (t.type) {
    case "dissolve":
      if (incoming) look.alpha = p;
      break;
    case "fade-black":
      look.darkness = incoming ? clamp01(2 * (1 - p)) : clamp01(2 * p);
      break;
    case "slide-left":
      look.shiftX = incoming ? 1 - p : -p;
      break;
    case "slide-right":
      look.shiftX = incoming ? -(1 - p) : p;
      break;
    case "wipe-left":
      if (incoming) look.revealX = { from: 1 - p, to: 1 };
      break;
    case "wipe-right":
      if (incoming) look.revealX = { from: 0, to: p };
      break;
    case "zoom":
      if (incoming) { look.alpha = p; look.scale = 0.5 + 0.5 * p; } else look.scale = 1 + 0.5 * p;
      break;
    case "blur":
      if (incoming) look.alpha = p;
      look.blur = incoming ? 1 - p : p;
      break;
    case "flash":
      look.lightness = incoming ? clamp01(2 * (1 - p)) : clamp01(2 * p);
      break;
    case "glitch":
      look.glitch = glitchLook(p);
      break;
  }
  return look;
}
