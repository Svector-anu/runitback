export const PREVIEW_SNAP_SCREEN_PX = 8;
export const ROTATION_SNAP_STEP = 90;
export const ROTATION_SNAP_THRESHOLD = 5;

export interface PositionSnap {
  dx: number;
  dy: number;
  guideX: number | null;
  guideY: number | null;
}

/**
 * Snaps an element's centre or edges to the canvas centre and edges. `cx/cy` are offsets from the canvas centre.
 * Rotation-aware extents keep rotated shapes flush to the edge.
 */
export function snapPosition(input: {
  cx: number; cy: number; width: number; height: number; rotationDegrees: number; canvasWidth: number; canvasHeight: number; threshold: number;
}): PositionSnap {
  const rad = (input.rotationDegrees * Math.PI) / 180;
  const halfW = (input.width * Math.abs(Math.cos(rad)) + input.height * Math.abs(Math.sin(rad))) / 2;
  const halfH = (input.width * Math.abs(Math.sin(rad)) + input.height * Math.abs(Math.cos(rad))) / 2;
  const axis = (pos: number, half: number, canvasHalf: number): { delta: number; guide: number | null } => {
    const candidates = [
      { delta: -pos, guide: 0 },
      { delta: -canvasHalf - (pos - half), guide: -canvasHalf },
      { delta: canvasHalf - (pos + half), guide: canvasHalf },
      { delta: -canvasHalf - pos, guide: -canvasHalf },
      { delta: canvasHalf - pos, guide: canvasHalf },
    ];
    let best: { delta: number; guide: number | null } = { delta: 0, guide: null };
    let bestDist = input.threshold + 1e-9;
    for (const c of candidates) {
      if (Math.abs(c.delta) < bestDist) {
        best = c;
        bestDist = Math.abs(c.delta);
      }
    }
    return best;
  };
  const x = axis(input.cx, halfW, input.canvasWidth / 2);
  const y = axis(input.cy, halfH, input.canvasHeight / 2);
  return { dx: x.delta, dy: y.delta, guideX: x.guide, guideY: y.guide };
}

export function snapRotation(degrees: number): number {
  const nearest = Math.round(degrees / ROTATION_SNAP_STEP) * ROTATION_SNAP_STEP;
  return Math.abs(degrees - nearest) <= ROTATION_SNAP_THRESHOLD ? nearest : degrees;
}

/** Signed angle difference normalised to (-180, 180]. */
export function normalizeDelta(degrees: number): number {
  let d = ((degrees + 180) % 360 + 360) % 360 - 180;
  if (d === -180) d = 180;
  return d;
}
