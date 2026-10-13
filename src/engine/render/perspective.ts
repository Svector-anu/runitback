import { DEFAULT_PERSPECTIVE, MAX_TILT_DEGREES, PARAM, PERSPECTIVE_MAX, PERSPECTIVE_MIN, numberParam, type ParamValues } from "#/engine/model";

/** Perspective tilt of a layer about its own centre. Positive `x` tips the top edge away from the viewer, positive `y` the right edge. */
export interface LayerTilt {
  /** Degrees about the horizontal axis. */
  x: number;
  /** Degrees about the vertical axis. */
  y: number;
  /** Camera distance in multiples of the layer's longer side. */
  perspective: number;
}

const clamp = (v: number, min: number, max: number): number => Math.min(max, Math.max(min, v));

/** The tilt from the `transform.rotateX/rotateY/perspective` params, or null while the layer is flat. */
export function resolveTilt(params: ParamValues): LayerTilt | null {
  const x = clamp(numberParam(params, PARAM.rotateX, 0), -MAX_TILT_DEGREES, MAX_TILT_DEGREES);
  const y = clamp(numberParam(params, PARAM.rotateY, 0), -MAX_TILT_DEGREES, MAX_TILT_DEGREES);
  if (Math.abs(x) < 0.01 && Math.abs(y) < 0.01) return null;
  return { x, y, perspective: clamp(numberParam(params, PARAM.perspective, DEFAULT_PERSPECTIVE), PERSPECTIVE_MIN, PERSPECTIVE_MAX) };
}

export interface Point2 { x: number; y: number }

/**
 * Where a point of the flat layer lands once the layer is rotated and viewed from `distance` in front of its centre.
 * `p` is relative to the centre (y down). The rotation is about Y first, then X; depth grows away from the viewer.
 */
export function projectTilted(input: { p: Point2; tilt: Pick<LayerTilt, "x" | "y">; distance: number }): Point2 {
  const ay = (input.tilt.y * Math.PI) / 180;
  const ax = (input.tilt.x * Math.PI) / 180;
  const x1 = input.p.x * Math.cos(ay);
  const z1 = input.p.x * Math.sin(ay);
  const y2 = input.p.y * Math.cos(ax) + z1 * Math.sin(ax);
  const z2 = -input.p.y * Math.sin(ax) + z1 * Math.cos(ax);
  const k = input.distance / Math.max(input.distance * 0.05, input.distance + z2);
  return { x: x1 * k, y: y2 * k };
}

export interface TiltTriangle {
  /** Corners in the flat layer, as canvas coordinates. */
  src: [Point2, Point2, Point2];
  /** The same corners after the tilt, as canvas coordinates. */
  dst: [Point2, Point2, Point2];
}

export interface TiltGrid {
  /** Box of the flat content, in canvas pixels. */
  box: { left: number; top: number; width: number; height: number };
  /** The point the layer turns about, in canvas pixels. */
  pivot: Point2;
  tilt: LayerTilt;
}

/** Longest side of a mesh cell in pixels: small enough that straight lines stay straight under a strong tilt. */
export const TILT_CELL_PX = 48;
export const TILT_MAX_CELLS = 40;

/** The content box cut into a grid of triangles, each mapped by an affine transform that matches the projection at its corners. */
export function tiltMesh(input: TiltGrid): TiltTriangle[] {
  const { box, pivot, tilt } = input;
  const distance = tilt.perspective * Math.max(box.width, box.height);
  const cols = clamp(Math.ceil(box.width / TILT_CELL_PX), 2, TILT_MAX_CELLS);
  const rows = clamp(Math.ceil(box.height / TILT_CELL_PX), 2, TILT_MAX_CELLS);
  const flat = (c: number, r: number): Point2 => ({ x: box.left + (box.width * c) / cols, y: box.top + (box.height * r) / rows });
  const tilted = (p: Point2): Point2 => {
    const q = projectTilted({ p: { x: p.x - pivot.x, y: p.y - pivot.y }, tilt, distance });
    return { x: pivot.x + q.x, y: pivot.y + q.y };
  };
  const triangles: TiltTriangle[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const a = flat(c, r);
      const b = flat(c + 1, r);
      const d = flat(c, r + 1);
      const e = flat(c + 1, r + 1);
      triangles.push({ src: [a, b, d], dst: [tilted(a), tilted(b), tilted(d)] }, { src: [b, e, d], dst: [tilted(b), tilted(e), tilted(d)] });
    }
  }
  return triangles;
}

export interface AffineMatrix { a: number; b: number; c: number; d: number; e: number; f: number }

/** The affine transform (canvas `setTransform` order) taking triangle `from` onto triangle `to`; null when `from` is degenerate. */
export function affineBetween(from: [Point2, Point2, Point2], to: [Point2, Point2, Point2]): AffineMatrix | null {
  const [p0, p1, p2] = from;
  const [q0, q1, q2] = to;
  const det = (p1.x - p0.x) * (p2.y - p0.y) - (p2.x - p0.x) * (p1.y - p0.y);
  if (Math.abs(det) < 1e-9) return null;
  const a = ((q1.x - q0.x) * (p2.y - p0.y) - (q2.x - q0.x) * (p1.y - p0.y)) / det;
  const c = ((q2.x - q0.x) * (p1.x - p0.x) - (q1.x - q0.x) * (p2.x - p0.x)) / det;
  const b = ((q1.y - q0.y) * (p2.y - p0.y) - (q2.y - q0.y) * (p1.y - p0.y)) / det;
  const d = ((q2.y - q0.y) * (p1.x - p0.x) - (q1.y - q0.y) * (p2.x - p0.x)) / det;
  return { a, b, c, d, e: q0.x - a * p0.x - c * p0.y, f: q0.y - b * p0.x - d * p0.y };
}

/** Axis-aligned box around a `width` x `height` rectangle centred on `center` and turned by `degrees`. */
export function rotatedBox(input: { center: Point2; width: number; height: number; degrees: number }): { left: number; top: number; width: number; height: number } {
  const r = (input.degrees * Math.PI) / 180;
  const w = Math.abs(input.width * Math.cos(r)) + Math.abs(input.height * Math.sin(r));
  const h = Math.abs(input.width * Math.sin(r)) + Math.abs(input.height * Math.cos(r));
  return { left: input.center.x - w / 2, top: input.center.y - h / 2, width: w, height: h };
}
