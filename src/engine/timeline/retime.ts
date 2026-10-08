import { clampRate, type RetimeConfig } from "#/engine/model";
import { roundMediaTime, type MediaTime } from "#/engine/time";

export function effectiveRate(retime: RetimeConfig | undefined): number {
  return retime ? clampRate(retime.rate) : 1;
}

/** Source time consumed by `clipTime` of timeline time. */
export function sourceSpanAtClipTime(clipTime: number, retime: RetimeConfig | undefined): number {
  return Math.max(0, clipTime * effectiveRate(retime));
}

export function timelineDurationForSourceSpan(span: number, retime: RetimeConfig | undefined): MediaTime {
  return roundMediaTime(span <= 0 ? 0 : span / effectiveRate(retime));
}

/** Position in the source media for a point `clipTime` into the clip. */
export function sourceTimeAt(input: { trimStart: number; clipTime: number; retime: RetimeConfig | undefined }): number {
  return input.trimStart + input.clipTime * effectiveRate(input.retime);
}
