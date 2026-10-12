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
}

export function easeTransition(t: number): number {
  const x = Math.min(1, Math.max(0, t));
  return x * x * (3 - 2 * x);
}

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));

/** False when the layer contributes nothing at this progress (fade-through-black shows one clip per half). */
export function isTransitionLayerVisible(t: LayerTransition): boolean {
  if (t.type !== "fade-black") return true;
  return t.role === "out" ? t.progress < 0.5 : t.progress >= 0.5;
}

export function transitionLook(t: LayerTransition): TransitionLook {
  const p = clamp01(t.progress);
  const incoming = t.role === "in";
  const look: TransitionLook = { alpha: 1, shiftX: 0, scale: 1, darkness: 0, revealX: null };
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
  }
  return look;
}
