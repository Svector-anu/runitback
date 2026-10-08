import { mediaTime } from "#/engine/time";
import { orderedTracks, type SceneTracks, type TimelineElement } from "#/engine/model";
import { elementEnd, mapTracks, withElements } from "./tracks";

export interface RippleAdjustment {
  trackId: string;
  afterTime: number;
  shiftAmount: number;
}

interface Interval { start: number; end: number }

function mergeIntervals(intervals: Interval[]): Interval[] {
  const sorted = [...intervals].sort((a, b) => a.start - b.start);
  const out: Interval[] = [];
  for (const i of sorted) {
    const last = out[out.length - 1];
    if (last && i.start <= last.end) last.end = Math.max(last.end, i.end);
    else out.push({ ...i });
  }
  return out;
}

function subtractIntervals(from: Interval[], remove: Interval[]): Interval[] {
  let result = from;
  for (const r of remove) {
    const next: Interval[] = [];
    for (const f of result) {
      if (r.end <= f.start || r.start >= f.end) {
        next.push(f);
        continue;
      }
      if (r.start > f.start) next.push({ start: f.start, end: r.start });
      if (r.end < f.end) next.push({ start: r.end, end: f.end });
    }
    result = next;
  }
  return result;
}

/**
 * Diff before/after per track. Deleted elements and elements whose end moved earlier free time;
 * elements that appear (new or moved in) take it back. Elements moved to another track do not ripple their source.
 */
export function computeRippleAdjustments(input: { before: SceneTracks; after: SceneTracks }): RippleAdjustment[] {
  const afterTracks = new Map(orderedTracks(input.after).map((t) => [t.id, t]));
  const afterIds = new Set<string>();
  for (const t of afterTracks.values()) for (const e of t.elements as TimelineElement[]) afterIds.add(e.id);

  const adjustments: RippleAdjustment[] = [];
  for (const track of orderedTracks(input.before)) {
    const after = afterTracks.get(track.id);
    if (!after) continue;
    const afterById = new Map((after.elements as TimelineElement[]).map((e) => [e.id, e]));
    const beforeIds = new Set((track.elements as TimelineElement[]).map((e) => e.id));
    const vacated: Interval[] = [];
    const joined: Interval[] = [];
    for (const e of track.elements as TimelineElement[]) {
      const now = afterById.get(e.id);
      if (!now) {
        if (!afterIds.has(e.id)) vacated.push({ start: e.startTime, end: elementEnd(e) });
      } else if (elementEnd(e) > elementEnd(now)) {
        vacated.push({ start: elementEnd(now), end: elementEnd(e) });
      }
    }
    for (const e of after.elements as TimelineElement[]) {
      if (!beforeIds.has(e.id)) joined.push({ start: e.startTime, end: elementEnd(e) });
    }
    const freed = subtractIntervals(mergeIntervals(vacated), mergeIntervals(joined));
    for (const interval of freed) {
      const length = interval.end - interval.start;
      if (length > 0) adjustments.push({ trackId: track.id, afterTime: interval.end, shiftAmount: length });
    }
  }
  return adjustments;
}

export function applyRippleAdjustments(input: { tracks: SceneTracks; adjustments: ReadonlyArray<RippleAdjustment> }): SceneTracks {
  if (input.adjustments.length === 0) return input.tracks;
  return mapTracks(input.tracks, (track) => {
    const mine = input.adjustments.filter((a) => a.trackId === track.id).sort((a, b) => b.afterTime - a.afterTime);
    if (mine.length === 0) return track;
    let elements = track.elements as TimelineElement[];
    for (const adj of mine) {
      elements = elements.map((e) =>
        e.startTime >= adj.afterTime ? ({ ...e, startTime: mediaTime(e.startTime - adj.shiftAmount) } as TimelineElement) : e);
    }
    return withElements(track, elements);
  });
}

export function rippleEdit(input: { before: SceneTracks; after: SceneTracks }): SceneTracks {
  return applyRippleAdjustments({ tracks: input.after, adjustments: computeRippleAdjustments(input) });
}
