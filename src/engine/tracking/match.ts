import type { LumaFrame, Point2 } from "./types";

/** A template normalised to zero mean and unit variance, cut from a frame around an integer centre. */
export interface Template {
  half: number;
  size: number;
  values: Float32Array;
}

export interface Match extends Point2 {
  /** Normalised cross-correlation at the (sub-pixel) best position, -1..1. */
  score: number;
}

const inside = (frame: LumaFrame, cx: number, cy: number, half: number): boolean =>
  cx - half >= 0 && cy - half >= 0 && cx + half < frame.width && cy + half < frame.height;

/**
 * How well a patch can be followed in both directions: the smaller eigenvalue of its gradient structure tensor, per
 * pixel. A flat patch scores 0, a straight edge (which can slide along itself unseen) scores near 0, a corner or
 * speckle scores high.
 */
export function textureScore(frame: LumaFrame, cx: number, cy: number, half: number): number {
  if (cx - half < 1 || cy - half < 1 || cx + half >= frame.width - 1 || cy + half >= frame.height - 1) return 0;
  let xx = 0, xy = 0, yy = 0;
  const w = frame.width, d = frame.data;
  for (let y = cy - half; y <= cy + half; y++) {
    for (let x = cx - half; x <= cx + half; x++) {
      const i = y * w + x;
      const gx = ((d[i + 1] as number) - (d[i - 1] as number)) / 2, gy = ((d[i + w] as number) - (d[i - w] as number)) / 2;
      xx += gx * gx; xy += gx * gy; yy += gy * gy;
    }
  }
  const n = (2 * half + 1) ** 2;
  xx /= n; xy /= n; yy /= n;
  const trace = xx + yy;
  return trace / 2 - Math.sqrt(Math.max(0, (trace * trace) / 4 - (xx * yy - xy * xy)));
}

/** Minimum `textureScore` of a patch worth following. */
export const MIN_TEXTURE = 12;

/** The patch of side `2 * half + 1` around (cx, cy), or null when it leaves the frame or has no corner-like detail to follow. */
export function cutTemplate(frame: LumaFrame, cx: number, cy: number, half: number): Template | null {
  if (!inside(frame, cx, cy, half)) return null;
  if (textureScore(frame, cx, cy, half) < MIN_TEXTURE) return null;
  const size = 2 * half + 1;
  const values = new Float32Array(size * size);
  let sum = 0;
  let k = 0;
  for (let y = cy - half; y <= cy + half; y++) {
    for (let x = cx - half; x <= cx + half; x++) {
      const v = frame.data[y * frame.width + x] as number;
      values[k++] = v;
      sum += v;
    }
  }
  const mean = sum / values.length;
  let variance = 0;
  for (let i = 0; i < values.length; i++) {
    const d = (values[i] as number) - mean;
    values[i] = d;
    variance += d * d;
  }
  const std = Math.sqrt(variance / values.length);
  if (std < 2) return null;
  for (let i = 0; i < values.length; i++) values[i] = (values[i] as number) / std;
  return { half, size, values };
}

/** NCC of the template against the window of `frame` centred on integer (cx, cy); -2 when the window is outside or flat. */
export function nccAt(frame: LumaFrame, template: Template, cx: number, cy: number): number {
  const { half, size, values } = template;
  if (!inside(frame, cx, cy, half)) return -2;
  let sum = 0, sumSq = 0, dot = 0, k = 0;
  for (let y = cy - half; y <= cy + half; y++) {
    const row = y * frame.width;
    for (let x = cx - half; x <= cx + half; x++) {
      const v = frame.data[row + x] as number;
      sum += v;
      sumSq += v * v;
      dot += (values[k++] as number) * v;
    }
  }
  const n = size * size;
  const variance = sumSq / n - (sum / n) ** 2;
  if (variance < 4) return -2;
  return dot / (n * Math.sqrt(variance));
}

function bilinear(frame: LumaFrame, x: number, y: number): number {
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const fx = x - x0, fy = y - y0;
  const w = frame.width, d = frame.data;
  const i = y0 * w + x0;
  const a = d[i] as number, b = d[i + 1] as number, c = d[i + w] as number, e = d[i + w + 1] as number;
  return a + (b - a) * fx + (c - a) * fy + (a - b - c + e) * fx * fy;
}

/**
 * Gauss-Newton refinement of the template position to a fraction of a pixel (translation-only Lucas-Kanade on the
 * zero-mean, unit-variance patch), starting from an integer match. Returns null when the window leaves the frame, so
 * callers keep the integer result.
 */
function refine(frame: LumaFrame, template: Template, start: Point2): Match | null {
  const { half, size, values } = template;
  let px = start.x, py = start.y;
  const n = size * size;
  const patch = new Float32Array(n), gx = new Float32Array(n), gy = new Float32Array(n);
  let score = -2;
  for (let iteration = 0; iteration < 6; iteration++) {
    if (px - half - 1 < 0 || py - half - 1 < 0 || px + half + 2 >= frame.width || py + half + 2 >= frame.height) return null;
    let sum = 0, sumSq = 0, k = 0;
    for (let dy = -half; dy <= half; dy++) {
      for (let dx = -half; dx <= half; dx++) {
        const x = px + dx, y = py + dy;
        const v = bilinear(frame, x, y);
        patch[k] = v;
        gx[k] = (bilinear(frame, x + 1, y) - bilinear(frame, x - 1, y)) / 2;
        gy[k] = (bilinear(frame, x, y + 1) - bilinear(frame, x, y - 1)) / 2;
        sum += v;
        sumSq += v * v;
        k++;
      }
    }
    const mean = sum / n;
    const variance = sumSq / n - mean * mean;
    if (variance < 4) return null;
    const sigma = Math.sqrt(variance);
    let hxx = 0, hxy = 0, hyy = 0, bx = 0, by = 0, dot = 0;
    for (let i = 0; i < n; i++) {
      const target = values[i] as number;
      const current = ((patch[i] as number) - mean) / sigma;
      const jx = (gx[i] as number) / sigma, jy = (gy[i] as number) / sigma;
      const residual = target - current;
      hxx += jx * jx; hxy += jx * jy; hyy += jy * jy;
      bx += jx * residual; by += jy * residual;
      dot += target * current;
    }
    score = dot / n;
    const det = hxx * hyy - hxy * hxy;
    if (det < 1e-6) break;
    const stepX = (hyy * bx - hxy * by) / det, stepY = (hxx * by - hxy * bx) / det;
    if (!Number.isFinite(stepX) || !Number.isFinite(stepY) || Math.abs(stepX) > 1.5 || Math.abs(stepY) > 1.5) return null;
    px += stepX;
    py += stepY;
    if (Math.abs(stepX) < 0.005 && Math.abs(stepY) < 0.005) break;
  }
  return { x: px, y: py, score };
}

/** Best match of the template within `radius` integer pixels of the centre, refined to sub-pixel; null when nothing in range is textured enough. */
export function findTemplate(frame: LumaFrame, template: Template, centre: Point2, radius: number): Match | null {
  const cx = Math.round(centre.x), cy = Math.round(centre.y);
  let best = -2, bx = cx, by = cy;
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      const s = nccAt(frame, template, cx + dx, cy + dy);
      if (s > best) { best = s; bx = cx + dx; by = cy + dy; }
    }
  }
  if (best <= -2) return null;
  const refined = refine(frame, template, { x: bx, y: by });
  if (refined && Math.hypot(refined.x - bx, refined.y - by) <= 1.5 && refined.score >= best - 0.02) return refined;
  return { x: bx, y: by, score: best };
}
