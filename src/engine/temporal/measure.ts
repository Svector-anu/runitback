import type { LevelCurve } from "#/engine/analysis";
import { SILENCE_FLOOR_DB } from "#/engine/analysis";
import type { SourceSpan, TemporalEvent } from "./types";

export const overlapSeconds = (a: SourceSpan, b: SourceSpan): number => Math.max(0, Math.min(a.endSeconds, b.endSeconds) - Math.max(a.startSeconds, b.startSeconds));

export interface LevelStats {
  meanDb: number;
  peakDb: number;
}

/** Power-averaged and peak level of `span` from a level curve; null when the curve does not reach the span. */
export function levelStats(levels: LevelCurve | null, span: SourceSpan): LevelStats | null {
  if (!levels || levels.db.length === 0) return null;
  const step = levels.windowSeconds;
  const first = Math.max(0, Math.floor(span.startSeconds / step));
  const last = Math.min(levels.db.length - 1, Math.ceil(span.endSeconds / step) - 1);
  let weight = 0;
  let power = 0;
  let peakDb = SILENCE_FLOOR_DB;
  let seen = false;
  for (let i = first; i <= last; i++) {
    const db = levels.db[i] as number;
    const covered = overlapSeconds({ startSeconds: i * step, endSeconds: (i + 1) * step }, span);
    if (covered <= 0) continue;
    seen = true;
    weight += covered;
    power += covered * 10 ** (db / 10);
    peakDb = Math.max(peakDb, db);
  }
  if (!seen || weight <= 0) return null;
  return { meanDb: Math.max(SILENCE_FLOOR_DB, 10 * Math.log10(power / weight)), peakDb };
}

/** Share of `span` covered by `events`, 0..1. Events are assumed not to overlap each other. */
export function coverageRatio(events: ReadonlyArray<TemporalEvent>, span: SourceSpan): number {
  const length = span.endSeconds - span.startSeconds;
  if (length <= 0) return 0;
  const covered = events.reduce((sum, event) => sum + overlapSeconds(event, span), 0);
  return Math.min(1, covered / length);
}

/** Index of the shot that contains `seconds` (the last shot when it is past the end). */
export function shotIndexAt(shots: ReadonlyArray<SourceSpan>, seconds: number): number {
  let found = 0;
  for (let i = 0; i < shots.length; i++) {
    if ((shots[i] as SourceSpan).startSeconds <= seconds) found = i;
    else break;
  }
  return found;
}

export const roundMs = (value: number): number => Math.round(value * 1000) / 1000;
export const roundDb = (value: number): number => Math.round(value * 10) / 10;
