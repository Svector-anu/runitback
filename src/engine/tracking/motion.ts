import { MIN_TEXTURE, cutTemplate, findTemplate, textureScore } from "./match";
import type { LumaFrame, MotionSample } from "./types";

export interface MotionOptions {
  /** Half side of the measuring blocks in analysis pixels. Default 10. */
  half?: number;
  /** Largest per-frame shift measured, in analysis pixels. Default 10. */
  maxShift?: number;
  /** A block only votes when its match is at least this good. Default 0.7. */
  minScore?: number;
  /** Blocks across and down. Default 4 x 3. */
  columns?: number;
  rows?: number;
}

const MOTION_DEFAULTS = { half: 10, maxShift: 10, minScore: 0.7, columns: 4, rows: 3 } as const;
const AGREE_WITHIN = 1;

interface Vote { x: number; y: number; weight: number }

/** The biggest group of votes that agree within a pixel, as the weighted mean of that group; a lone subject cannot outvote the background. */
function dominantShift(votes: Vote[]): { x: number; y: number; support: number } {
  let best: Vote[] = [];
  let bestWeight = -1;
  for (const centre of votes) {
    const group = votes.filter((v) => Math.abs(v.x - centre.x) <= AGREE_WITHIN && Math.abs(v.y - centre.y) <= AGREE_WITHIN);
    const weight = group.reduce((s, v) => s + v.weight, 0);
    if (group.length > best.length || (group.length === best.length && weight > bestWeight)) { best = group; bestWeight = weight; }
  }
  const total = best.reduce((s, v) => s + v.weight, 0);
  return { x: best.reduce((s, v) => s + v.x * v.weight, 0) / total, y: best.reduce((s, v) => s + v.y * v.weight, 0) / total, support: best.length };
}

/**
 * Camera shift between two frames, as how far the content moved (previous -> current), in analysis pixels. A grid of
 * blocks each vote with their own best match (weighted by how much detail they have); the largest group of agreeing
 * votes wins, so a subject moving through part of the frame does not drag the estimate. `support` is the size of
 * that group; fewer than 2 means the shift could not be measured and is reported as no movement.
 */
export function estimateShift(previous: LumaFrame, current: LumaFrame, options: MotionOptions = {}): { x: number; y: number; support: number } {
  const o = { ...MOTION_DEFAULTS, ...options };
  const margin = o.half + o.maxShift + 1;
  const votes: Vote[] = [];
  for (let gy = 0; gy < o.rows; gy++) {
    for (let gx = 0; gx < o.columns; gx++) {
      const cx = Math.round(margin + ((previous.width - 2 * margin) * (gx + 0.5)) / o.columns);
      const cy = Math.round(margin + ((previous.height - 2 * margin) * (gy + 0.5)) / o.rows);
      const texture = textureScore(previous, cx, cy, o.half);
      const template = texture >= MIN_TEXTURE ? cutTemplate(previous, cx, cy, o.half) : null;
      if (!template) continue;
      const match = findTemplate(current, template, { x: cx, y: cy }, o.maxShift);
      if (match && match.score >= o.minScore) votes.push({ x: match.x - cx, y: match.y - cy, weight: Math.min(200, texture) });
    }
  }
  if (votes.length < 2) return { x: 0, y: 0, support: votes.length };
  const shift = dominantShift(votes);
  return shift.support < 2 ? { x: 0, y: 0, support: shift.support } : shift;
}

/** Cumulative content displacement of every frame relative to the first. */
export function cameraPath(input: { frames: ReadonlyArray<LumaFrame>; times: ReadonlyArray<number>; options?: MotionOptions }): MotionSample[] {
  const { frames, times } = input;
  if (frames.length === 0 || frames.length !== times.length) throw new Error("cameraPath needs one time per frame and at least one frame");
  const out: MotionSample[] = [{ t: times[0] as number, x: 0, y: 0, support: 0 }];
  let x = 0, y = 0;
  for (let i = 1; i < frames.length; i++) {
    const shift = estimateShift(frames[i - 1] as LumaFrame, frames[i] as LumaFrame, input.options);
    x += shift.x;
    y += shift.y;
    out.push({ t: times[i] as number, x, y, support: shift.support });
  }
  return out;
}

export interface StabilizeResult {
  /** Per sample: how far to move the picture so the content sits on the smoothed path, in analysis pixels. */
  corrections: Array<{ t: number; x: number; y: number }>;
  /** Largest correction on each axis, in analysis pixels. */
  maxX: number;
  maxY: number;
  /** Share of frames whose shift was measured (enough blocks agreed). */
  measuredShare: number;
}

/** Gaussian-smooths a path (sigma in samples, edges held) and returns the offsets from the raw path to the smooth one. */
export function stabilize(input: { path: ReadonlyArray<MotionSample>; sigmaSamples: number }): StabilizeResult {
  const { path } = input;
  const sigma = Math.max(0.5, input.sigmaSamples);
  const radius = Math.ceil(sigma * 3);
  const kernel: number[] = [];
  for (let k = -radius; k <= radius; k++) kernel.push(Math.exp(-(k * k) / (2 * sigma * sigma)));
  const at = (i: number, axis: "x" | "y"): number => (path[Math.min(path.length - 1, Math.max(0, i))] as MotionSample)[axis];
  const smooth = (i: number, axis: "x" | "y"): number => {
    let sum = 0, weight = 0;
    for (let k = -radius; k <= radius; k++) { const w = kernel[k + radius] as number; sum += w * at(i + k, axis); weight += w; }
    return sum / weight;
  };
  const corrections = path.map((p, i) => ({ t: p.t, x: smooth(i, "x") - p.x, y: smooth(i, "y") - p.y }));
  const measured = path.slice(1).filter((p) => p.support >= 2).length;
  return {
    corrections,
    maxX: Math.max(0, ...corrections.map((c) => Math.abs(c.x))),
    maxY: Math.max(0, ...corrections.map((c) => Math.abs(c.y))),
    measuredShare: path.length > 1 ? measured / (path.length - 1) : 1,
  };
}
