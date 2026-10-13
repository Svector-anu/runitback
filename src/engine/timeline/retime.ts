import { clampRate, type RetimeConfig, type SpeedCurve } from "#/engine/model";
import { roundMediaTime, type MediaTime } from "#/engine/time";
import { curveSource, curveTime } from "./speed-curve";

export function effectiveRate(retime: RetimeConfig | undefined): number {
  return retime ? clampRate(retime.rate) : 1;
}

export function speedCurveOf(retime: RetimeConfig | undefined): SpeedCurve | undefined {
  return retime?.curve;
}

/**
 * Source time consumed by `clipTime` of timeline time, for a clip whose visible window starts at source position
 * `from` (its trimStart). `from` only matters for a speed curve; a constant rate does not care where it starts.
 */
export function sourceSpanAtClipTime(clipTime: number, retime: RetimeConfig | undefined, from = 0): number {
  const curve = speedCurveOf(retime);
  if (curve) return curveSource(curve, curveTime(curve, from) + Math.max(0, clipTime)) - from;
  return Math.max(0, clipTime * effectiveRate(retime));
}

/** Timeline time to play `span` of source starting at source position `from`. */
export function timelineDurationForSourceSpan(span: number, retime: RetimeConfig | undefined, from = 0): MediaTime {
  const curve = speedCurveOf(retime);
  if (curve) return roundMediaTime(span <= 0 ? 0 : curveTime(curve, from + span) - curveTime(curve, from));
  return roundMediaTime(span <= 0 ? 0 : span / effectiveRate(retime));
}

/**
 * Position in the source media for a point `clipTime` into the clip. `clipTime` may be negative or beyond the clip
 * (transitions hold neighbours past their ends); a curve extends flat at its end rates there.
 */
export function sourceTimeAt(input: { trimStart: number; clipTime: number; retime: RetimeConfig | undefined }): number {
  const curve = speedCurveOf(input.retime);
  if (curve) return curveSource(curve, curveTime(curve, input.trimStart) + input.clipTime);
  return input.trimStart + input.clipTime * effectiveRate(input.retime);
}

/** The same mapping inverted: clip time at which source position `source` plays, for a window starting at `trimStart`. */
export function clipTimeAtSource(input: { trimStart: number; source: number; retime: RetimeConfig | undefined }): number {
  const curve = speedCurveOf(input.retime);
  if (curve) return curveTime(curve, input.source) - curveTime(curve, input.trimStart);
  return (input.source - input.trimStart) / effectiveRate(input.retime);
}

/**
 * Keeps `retime.rate` equal to the mean rate of a curved clip (visible source / duration), so everything that still
 * reasons with one number (the source-mapping invariant, waveforms, summaries) stays consistent. A no-op for constant rates.
 */
export function withDerivedRate<T extends { retime?: RetimeConfig | undefined; trimStart: number; trimEnd?: number; sourceDuration?: number | undefined; duration: number }>(element: T): T {
  const retime = element.retime;
  const curve = speedCurveOf(retime);
  if (!retime || !curve || element.duration <= 0) return element;
  const visible = element.sourceDuration !== undefined && element.trimEnd !== undefined
    ? element.sourceDuration - element.trimStart - element.trimEnd
    : sourceSpanAtClipTime(element.duration, retime, element.trimStart);
  const rate = clampRate(visible / element.duration);
  return Math.abs(rate - retime.rate) < 1e-12 ? element : { ...element, retime: { ...retime, rate } };
}
