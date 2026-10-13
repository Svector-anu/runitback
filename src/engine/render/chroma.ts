import { numberParam, stringParam, type ParamValues } from "#/engine/model";

/**
 * Chroma key maths shared by the CPU reference pass and the WebGL2 shader (which mirrors it constant for constant).
 * Keying happens in the Cb/Cr plane of BT.601 full-range YCbCr with the chroma divided by the pixel's brightness
 * (`chromaScale`), so a shadowed part of the screen keys nearly like a lit one while near-black pixels (whose hue is
 * noise) are not amplified into matches.
 */
export interface ChromaKeyPlan {
  keyCb: number;
  keyCr: number;
  /** Unit vector of the key in the Cb/Cr plane (0,0 for a grey key, which has no hue to remove as spill). */
  unitCb: number;
  unitCr: number;
  /** Chroma distance below which a pixel is fully removed. */
  threshold: number;
  /** Width of the soft edge above the threshold. */
  feather: number;
  /** 0..1 strength of the spill removal. */
  spill: number;
}

export const CHROMA_KEY_DEFAULT_COLOR = "#00ff00";
/** A chroma distance of 0.5 spans half of the Cb/Cr plane: similarity and smoothness 100 map here. */
const MAX_CHROMA_DISTANCE = 0.5;

export function parseHexColor(value: string): [number, number, number] | null {
  const m = /^#?([0-9a-f]{6})(?:[0-9a-f]{2})?$/i.exec(value.trim());
  if (!m) return null;
  const n = parseInt(m[1] as string, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Brightness normaliser: 1 for a full-brightness pixel, shrinking toward `CHROMA_FLOOR / (1 + CHROMA_FLOOR)` for black. */
export const CHROMA_FLOOR = 0.08;
export const chromaScale = (r: number, g: number, b: number): number => (Math.max(r, g, b) / 255 + CHROMA_FLOOR) / (1 + CHROMA_FLOOR);

export function toCbCr(r: number, g: number, b: number): { y: number; cb: number; cr: number } {
  const rn = r / 255, gn = g / 255, bn = b / 255;
  return {
    y: 0.299 * rn + 0.587 * gn + 0.114 * bn,
    cb: -0.168736 * rn - 0.331264 * gn + 0.5 * bn,
    cr: 0.5 * rn - 0.418688 * gn - 0.081312 * bn,
  };
}

export function chromaKeyPlan(params: ParamValues): ChromaKeyPlan {
  const rgb = parseHexColor(stringParam(params, "keyColor", CHROMA_KEY_DEFAULT_COLOR)) ?? [0, 255, 0];
  const { cb, cr } = toCbCr(rgb[0], rgb[1], rgb[2]);
  const keyScale = chromaScale(rgb[0], rgb[1], rgb[2]);
  const length = Math.hypot(cb, cr);
  const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));
  return {
    keyCb: cb / keyScale, keyCr: cr / keyScale,
    unitCb: length > 1e-4 ? cb / length : 0, unitCr: length > 1e-4 ? cr / length : 0,
    threshold: clamp01(numberParam(params, "similarity", 30) / 100) * MAX_CHROMA_DISTANCE,
    feather: clamp01(numberParam(params, "smoothness", 10) / 100) * MAX_CHROMA_DISTANCE,
    spill: clamp01(numberParam(params, "spill", 50) / 100),
  };
}

const smoothstep = (edge0: number, edge1: number, x: number): number => {
  if (edge1 <= edge0) return x < edge0 ? 0 : 1;
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
};

export interface KeyedPixel { r: number; g: number; b: number; alpha: number }

/** One pixel (0..255 channels, not premultiplied). `alpha` is the keyed opacity 0..1; colour is despilled. */
export function keyPixel(plan: ChromaKeyPlan, r: number, g: number, b: number): KeyedPixel {
  const { y, cb, cr } = toCbCr(r, g, b);
  const scale = chromaScale(r, g, b);
  const alpha = smoothstep(plan.threshold, plan.threshold + plan.feather, Math.hypot(cb / scale - plan.keyCb, cr / scale - plan.keyCr));
  let ncb = cb, ncr = cr;
  if (plan.spill > 0) {
    const along = Math.max(0, cb * plan.unitCb + cr * plan.unitCr);
    ncb -= along * plan.unitCb * plan.spill;
    ncr -= along * plan.unitCr * plan.spill;
  }
  const clamp = (v: number): number => Math.min(255, Math.max(0, Math.round(v * 255)));
  return {
    r: clamp(y + 1.402 * ncr),
    g: clamp(y - 0.344136 * ncb - 0.714136 * ncr),
    b: clamp(y + 1.772 * ncb),
    alpha,
  };
}

/** In-place CPU pass over unpremultiplied RGBA bytes: replaces colour with the despilled colour, scales alpha by the key. */
export function applyChromaKey(data: Uint8ClampedArray, plan: ChromaKeyPlan): void {
  for (let i = 0; i < data.length; i += 4) {
    const a = data[i + 3] as number;
    if (a === 0) continue;
    const px = keyPixel(plan, data[i] as number, data[i + 1] as number, data[i + 2] as number);
    data[i] = px.r; data[i + 1] = px.g; data[i + 2] = px.b;
    data[i + 3] = Math.round(a * px.alpha);
  }
}

/** The effect does nothing when similarity is 0 and there is no soft edge; the compositor skips it. */
export function chromaKeyIsNoop(plan: ChromaKeyPlan): boolean {
  return plan.threshold <= 0 && plan.feather <= 0;
}
