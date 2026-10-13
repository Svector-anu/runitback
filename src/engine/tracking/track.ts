import { cutTemplate, findTemplate } from "./match";
import type { LumaFrame, Point2, TrackSample } from "./types";

export interface TrackOptions {
  /** Half side of the matched patch in analysis pixels (patch side = 2 * half + 1). Default 10. */
  half?: number;
  /** Largest movement per sampled frame that is followed, in analysis pixels. Default 14. */
  radius?: number;
  /** Below this correlation the target counts as lost. Default 0.7. */
  lostBelow?: number;
  /** An anchor match (against the very first patch) at or above this overrides the frame-to-frame match, which stops drift. Default 0.75. */
  anchorAbove?: number;
  /** Looking for the original patch again after losing it needs this much correlation, so a look-alike elsewhere is not adopted. Default 0.9. */
  reacquireAbove?: number;
  /** After this many lost frames the original patch is no longer searched for. Default 90. */
  giveUpAfterFrames?: number;
}

export const TRACK_DEFAULTS = { half: 10, radius: 14, lostBelow: 0.7, anchorAbove: 0.75, reacquireAbove: 0.9, giveUpAfterFrames: 90 } as const;

/**
 * Follows one point through frames. Each frame is matched against the previous frame's patch (robust to slow change
 * of appearance) and then re-checked against the original patch within two pixels; when that agrees well the original
 * wins, so the path does not drift. Below `lostBelow` the point holds still and is flagged lost until the original
 * patch is found again near where the motion would have taken it. Translation only: a target that rotates, scales or is hidden is lost or drifts.
 */
export function trackPoint(input: { frames: ReadonlyArray<LumaFrame>; times: ReadonlyArray<number>; start: Point2; options?: TrackOptions }): TrackSample[] {
  const { frames, times } = input;
  if (frames.length === 0 || frames.length !== times.length) throw new Error("trackPoint needs one time per frame and at least one frame");
  const o = { ...TRACK_DEFAULTS, ...input.options };
  const first = frames[0] as LumaFrame;
  const anchor = cutTemplate(first, Math.round(input.start.x), Math.round(input.start.y), o.half);
  if (!anchor) throw new Error("There is not enough texture at that point to follow it; pick a corner or an edge with detail");
  const out: TrackSample[] = [{ t: times[0] as number, x: input.start.x, y: input.start.y, confidence: 1, lost: false }];
  let position: Point2 = { ...input.start };
  let velocity: Point2 = { x: 0, y: 0 };
  let previousFrame = first;
  let lostFor = 0;
  for (let i = 1; i < frames.length; i++) {
    const frame = frames[i] as LumaFrame;
    const t = times[i] as number;
    let next: { x: number; y: number; score: number } | null = null;
    if (lostFor === 0) {
      const template = cutTemplate(previousFrame, Math.round(position.x), Math.round(position.y), o.half);
      if (template) next = findTemplate(frame, template, { x: position.x + velocity.x, y: position.y + velocity.y }, o.radius);
    }
    if (!next || next.score < o.lostBelow) {
      const searching = lostFor < o.giveUpAfterFrames;
      const guess = { x: position.x + velocity.x * (lostFor + 1), y: position.y + velocity.y * (lostFor + 1) };
      const reacquired = searching ? findTemplate(frame, anchor, guess, o.radius * 2) : null;
      if (reacquired && reacquired.score >= o.reacquireAbove) {
        next = reacquired;
      } else {
        lostFor += 1;
        out.push({ t, x: position.x, y: position.y, confidence: Math.max(0, next?.score ?? 0), lost: true });
        previousFrame = frame;
        continue;
      }
    }
    const check = findTemplate(frame, anchor, next, 2);
    if (check && check.score >= o.anchorAbove) next = check;
    velocity = { x: 0.5 * velocity.x + 0.5 * (next.x - position.x) / (lostFor + 1), y: 0.5 * velocity.y + 0.5 * (next.y - position.y) / (lostFor + 1) };
    position = { x: next.x, y: next.y };
    lostFor = 0;
    out.push({ t, x: position.x, y: position.y, confidence: next.score, lost: false });
    previousFrame = frame;
  }
  return out;
}
