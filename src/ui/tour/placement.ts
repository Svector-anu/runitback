export interface Box { left: number; top: number; width: number; height: number }
export interface Viewport { width: number; height: number }
export type Side = "right" | "left" | "above" | "below";

const GAP = 12;
const MARGIN = 8;

/** Picks the side with the most room for a card of `card` size around `target`, preferring `preferred`. */
export function chooseSide({ target, card, viewport, preferred }: { target: Box; card: Box; viewport: Viewport; preferred: Side }): Side {
  const room: Record<Side, number> = {
    right: viewport.width - (target.left + target.width) - GAP - MARGIN - card.width,
    left: target.left - GAP - MARGIN - card.width,
    above: target.top - GAP - MARGIN - card.height,
    below: viewport.height - (target.top + target.height) - GAP - MARGIN - card.height,
  };
  if (room[preferred] >= 0) return preferred;
  return (Object.keys(room) as Side[]).reduce((best, side) => (room[side] > room[best] ? side : best), preferred);
}

/** Top-left of the card, kept inside the viewport. */
export function placeCard({ target, card, viewport, side }: { target: Box; card: Box; viewport: Viewport; side: Side }): { left: number; top: number } {
  let left: number;
  let top: number;
  if (side === "right") { left = target.left + target.width + GAP; top = target.top; }
  else if (side === "left") { left = target.left - GAP - card.width; top = target.top; }
  else if (side === "above") { left = target.left; top = target.top - GAP - card.height; }
  else { left = target.left + target.width - card.width; top = target.top + target.height + GAP; }
  return {
    left: Math.min(Math.max(MARGIN, left), Math.max(MARGIN, viewport.width - card.width - MARGIN)),
    top: Math.min(Math.max(MARGIN, top), Math.max(MARGIN, viewport.height - card.height - MARGIN)),
  };
}
