import { boxArea, boxCenterX, boxCenterY } from "./geometry";
import { trackFaces, type TrackedFace, type TrackOptions } from "./track";
import type { FaceBox, FaceDetections } from "./types";

/** One sample of where to look: the centre of the crop window in fractions of the source frame, and how far in to zoom. */
export interface FocusPoint {
  /** Source seconds. */
  t: number;
  centerX: number;
  centerY: number;
  /** 1 = the largest window of the target shape that fits the frame; 2 = half as wide and tall. */
  zoom: number;
  /** The crop window in fractions of the source frame (already accounts for `zoom`). */
  cropWidth: number;
  cropHeight: number;
  /** False where the point is held over, back-filled or neutral because no face was seen. */
  hasFace: boolean;
}

export interface FocusOptions {
  detections: FaceDetections;
  /** Width / height of the source frame. */
  sourceAspect: number;
  /** Width / height of the crop, e.g. 9 / 16. */
  targetAspect: number;
  /** "largest" follows one face (sticky to the same person); "all" frames every face in the frame together. Default "largest". */
  subject?: "largest" | "all";
  /** "auto" zooms in on small faces; "none" keeps the largest window. Default "auto". */
  zoom?: "auto" | "none";
  /** Face height as a share of the crop height that zoom aims for (default 0.3). */
  faceFill?: number;
  maxZoom?: number;
  /** How long to stay where the last face was when none is visible before easing back to the middle (default 3 s). */
  holdSeconds?: number;
  /** Movements smaller than this, in fractions of the source frame, are ignored (default 0.05). */
  deadZone?: number;
  /** Share of the remaining distance covered per sample once the dead zone is left, 0 < x <= 1 (default 0.6). */
  smoothing?: number;
  tracking?: TrackOptions;
}

export const DEFAULT_FACE_FILL = 0.3;
export const DEFAULT_MAX_ZOOM = 3;
export const DEFAULT_HOLD_SECONDS = 3;
export const DEFAULT_DEAD_ZONE = 0.05;
export const DEFAULT_FOCUS_SMOOTHING = 0.6;
/** A new face takes over from the one being followed only when it is this much bigger. */
const SWITCH_AREA_RATIO = 1.3;
/** Zoom changes smaller than this share of the current zoom are ignored. */
const ZOOM_DEAD_ZONE = 0.1;
const SAME = 1e-4;

/** Width and height, as fractions of the source frame, of the largest crop with the target shape that fits inside it. */
export function maxCrop(input: { sourceAspect: number; targetAspect: number }): { width: number; height: number } {
  return input.targetAspect <= input.sourceAspect
    ? { width: input.targetAspect / input.sourceAspect, height: 1 }
    : { width: 1, height: input.sourceAspect / input.targetAspect };
}

interface Target {
  t: number;
  cx: number;
  cy: number;
  zoom: number;
  hasFace: boolean;
}

function unionBox(faces: ReadonlyArray<FaceBox>): FaceBox {
  const x = Math.min(...faces.map((f) => f.x));
  const y = Math.min(...faces.map((f) => f.y));
  const right = Math.max(...faces.map((f) => f.x + f.width));
  const bottom = Math.max(...faces.map((f) => f.y + f.height));
  return { x, y, width: right - x, height: bottom - y, score: Math.max(...faces.map((f) => f.score)) };
}

function clampCentre(input: { cx: number; cy: number; zoom: number; crop: { width: number; height: number } }): { cx: number; cy: number } {
  const halfW = Math.min(0.5, input.crop.width / input.zoom / 2);
  const halfH = Math.min(0.5, input.crop.height / input.zoom / 2);
  return { cx: Math.min(1 - halfW, Math.max(halfW, input.cx)), cy: Math.min(1 - halfH, Math.max(halfH, input.cy)) };
}

/**
 * Where a crop of `targetAspect` should look, per sampled frame, to keep the speaker in view (auto-reframe, e.g. 16:9 to
 * 9:16). The followed face is tracked and sticky; frames without a face hold the last position, then ease back to the
 * middle; movement inside a small dead zone is ignored and the rest is eased, so the path does not jitter, except that a
 * subject who would end up outside the current window (a speaker change) is jumped to rather than eased, so they are
 * never off screen while the window catches up. The window never leaves the frame. Returns [] when no face was detected anywhere.
 */
export function faceFocusPath(options: FocusOptions): FocusPoint[] {
  const crop = maxCrop(options);
  const faceFill = options.faceFill ?? DEFAULT_FACE_FILL;
  const maxZoom = Math.max(1, options.maxZoom ?? DEFAULT_MAX_ZOOM);
  const holdSeconds = options.holdSeconds ?? DEFAULT_HOLD_SECONDS;
  const deadZone = options.deadZone ?? DEFAULT_DEAD_ZONE;
  const weight = Math.min(1, Math.max(Number.EPSILON, options.smoothing ?? DEFAULT_FOCUS_SMOOTHING));
  const frames = trackFaces(options.detections, options.tracking);

  let followed: number | undefined;
  const subjectOf = (faces: ReadonlyArray<TrackedFace>): FaceBox | undefined => {
    if (faces.length === 0) return undefined;
    if (options.subject === "all") return unionBox(faces);
    const biggest = faces.reduce((best, f) => (boxArea(f) > boxArea(best) ? f : best));
    const current = faces.find((f) => f.id === followed);
    const chosen = current && boxArea(biggest) <= boxArea(current) * SWITCH_AREA_RATIO ? current : biggest;
    followed = chosen.id;
    return chosen;
  };

  const raw: Target[] = [];
  let lastFace: Target | undefined;
  for (const frame of frames) {
    const subject = subjectOf(frame.faces);
    if (subject) {
      const fitHeight = (crop.height * faceFill) / subject.height;
      const fitWidth = (crop.width * faceFill) / subject.width;
      const zoom = options.zoom === "none" ? 1 : Math.min(maxZoom, Math.max(1, Math.min(fitHeight, fitWidth)));
      lastFace = { t: frame.t, cx: boxCenterX(subject), cy: boxCenterY(subject), zoom, hasFace: true };
      raw.push(lastFace);
    } else if (lastFace && frame.t - lastFace.t <= holdSeconds) {
      raw.push({ ...lastFace, t: frame.t, hasFace: false });
    } else {
      raw.push({ t: frame.t, cx: 0.5, cy: 0.5, zoom: 1, hasFace: false });
    }
  }
  const first = raw.find((r) => r.hasFace);
  if (!first) return [];
  for (let i = 0; i < raw.length && !raw[i]?.hasFace; i++) raw[i] = { ...first, t: raw[i]?.t ?? first.t, hasFace: false };

  const smoothed: FocusPoint[] = [];
  let state = { cx: first.cx, cy: first.cy, zoom: first.zoom };
  raw.forEach((target, i) => {
    if (i > 0) {
      const dx = Math.abs(target.cx - state.cx);
      const dy = Math.abs(target.cy - state.cy);
      const leavesWindow = dx > crop.width / state.zoom / 2 || dy > crop.height / state.zoom / 2;
      const moved = dx >= deadZone || dy >= deadZone || Math.abs(target.zoom - state.zoom) >= state.zoom * ZOOM_DEAD_ZONE;
      if (leavesWindow) {
        state = { cx: target.cx, cy: target.cy, zoom: target.zoom };
      } else if (moved) {
        state = {
          cx: state.cx + (target.cx - state.cx) * weight, cy: state.cy + (target.cy - state.cy) * weight,
          zoom: state.zoom + (target.zoom - state.zoom) * weight,
        };
      }
    }
    const centre = clampCentre({ cx: state.cx, cy: state.cy, zoom: state.zoom, crop });
    smoothed.push({
      t: target.t, centerX: centre.cx, centerY: centre.cy, zoom: state.zoom,
      cropWidth: Math.min(1, crop.width / state.zoom), cropHeight: Math.min(1, crop.height / state.zoom), hasFace: target.hasFace,
    });
  });
  return dropRedundant(smoothed);
}

const sameLook = (a: FocusPoint, b: FocusPoint): boolean =>
  Math.abs(a.centerX - b.centerX) < SAME && Math.abs(a.centerY - b.centerY) < SAME && Math.abs(a.zoom - b.zoom) < SAME;

/** Points that sit between two identical neighbours add nothing to a linear path. */
function dropRedundant(points: FocusPoint[]): FocusPoint[] {
  return points.filter((point, i) => {
    const before = points[i - 1];
    const after = points[i + 1];
    return !(before && after && sameLook(before, point) && sameLook(point, after));
  });
}

/** The focus at source time `t`, linearly between the surrounding points and held before the first and after the last. */
export function focusAt(path: ReadonlyArray<FocusPoint>, t: number): { centerX: number; centerY: number; zoom: number } | undefined {
  const first = path[0];
  const last = path[path.length - 1];
  if (!first || !last) return undefined;
  if (t <= first.t) return { centerX: first.centerX, centerY: first.centerY, zoom: first.zoom };
  if (t >= last.t) return { centerX: last.centerX, centerY: last.centerY, zoom: last.zoom };
  const nextIndex = path.findIndex((p) => p.t >= t);
  const next = path[nextIndex] as FocusPoint;
  const previous = path[nextIndex - 1] as FocusPoint;
  const f = next.t === previous.t ? 1 : (t - previous.t) / (next.t - previous.t);
  return {
    centerX: previous.centerX + (next.centerX - previous.centerX) * f,
    centerY: previous.centerY + (next.centerY - previous.centerY) * f,
    zoom: previous.zoom + (next.zoom - previous.zoom) * f,
  };
}

/**
 * The element transform (position in px from the canvas centre, uniform scale) that puts the focus centre in the middle
 * of the canvas, for a clip drawn the way the compositor draws it: contained in the canvas, then scaled. Zoom 1 is the
 * scale at which the clip just covers the canvas.
 */
export function focusTransform(input: {
  focus: { centerX: number; centerY: number; zoom: number };
  source: { width: number; height: number };
  canvas: { width: number; height: number };
}): { positionX: number; positionY: number; scale: number } {
  const { source, canvas, focus } = input;
  const contain = Math.min(canvas.width / source.width, canvas.height / source.height);
  const cover = Math.max(canvas.width / (source.width * contain), canvas.height / (source.height * contain));
  const scale = cover * focus.zoom;
  const crop = maxCrop({ sourceAspect: source.width / source.height, targetAspect: canvas.width / canvas.height });
  const { cx, cy } = clampCentre({ cx: focus.centerX, cy: focus.centerY, zoom: focus.zoom, crop });
  return {
    positionX: (0.5 - cx) * source.width * contain * scale,
    positionY: (0.5 - cy) * source.height * contain * scale,
    scale,
  };
}
