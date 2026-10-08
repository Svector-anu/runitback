import { mapSourceToTimeline } from "#/engine/transcript";
import type { SourceSpan } from "./types";

/** A clip of the asset as it sits on the timeline. Seconds throughout. */
export interface ClipPlacement {
  startSeconds: number;
  durationSeconds: number;
  /** Source offset at the clip start. */
  trimStartSeconds: number;
  /** Source seconds consumed per timeline second. */
  rate: number;
}

export interface TimelineRange {
  /** Index into the moments that were passed in. */
  momentIndex: number;
  startSeconds: number;
  endSeconds: number;
}

/**
 * Where source moments play on the timeline for one placed clip. Honors trim, speed and start; a moment that is only
 * partly inside the part the clip plays is clipped to it, one that is entirely outside is dropped.
 */
export function momentsToTimelineRanges(input: { moments: ReadonlyArray<SourceSpan>; placement: ClipPlacement }): TimelineRange[] {
  const { placement } = input;
  if (!(placement.rate > 0) || placement.durationSeconds <= 0) return [];
  const end = placement.startSeconds + placement.durationSeconds;
  const map = (source: number): number =>
    mapSourceToTimeline({ source, trimStart: placement.trimStartSeconds, rate: placement.rate, start: placement.startSeconds, end });
  return input.moments.flatMap((moment, momentIndex) => {
    const startSeconds = map(moment.startSeconds);
    const endSeconds = map(moment.endSeconds);
    return endSeconds > startSeconds ? [{ momentIndex, startSeconds, endSeconds }] : [];
  });
}
