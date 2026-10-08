import { clampDb, dbToLinear, numberParam, boolParam, PARAM, type TimelineElement, type TimelineTrack } from "#/engine/model";
import { resolveNumberAtTime } from "#/engine/animation";

/** Linear gain for a clip at element-local time (0 when muted by clip or track). */
export function clipGainAt(input: { element: TimelineElement; track: TimelineTrack; localTime: number }): number {
  const { element, track } = input;
  if ("muted" in track && track.muted) return 0;
  if (boolParam(element.params, PARAM.muted, false)) return 0;
  const base = numberParam(element.params, PARAM.volume, 0);
  const db = resolveNumberAtTime(element.animations, PARAM.volume, input.localTime, base);
  return dbToLinear(clampDb(db));
}

/** A clip contributes audio unless its source audio was extracted away or it is not audio-capable. */
export function clipHasAudible(element: TimelineElement): boolean {
  if (element.type === "audio") return true;
  return element.type === "video" && element.isSourceAudioEnabled !== false;
}

/** Map a point on the volume line (0 top .. 1 bottom) to dB using classic's square-law over linear gain. */
export function volumeLineToDb(fractionFromTop: number): number {
  const progress = 1 - Math.min(1, Math.max(0, fractionFromTop));
  const normalized = progress ** 2;
  const lo = 10 ** (-60 / 20);
  const hi = 10 ** (20 / 20);
  const gain = lo + normalized * (hi - lo);
  return Math.round(clampDb(20 * Math.log10(gain)) * 10) / 10;
}

export function dbToVolumeLine(db: number): number {
  const lo = 10 ** (-60 / 20);
  const hi = 10 ** (20 / 20);
  const normalized = (dbToLinear(clampDb(db)) - lo) / (hi - lo);
  return (1 - Math.sqrt(Math.max(0, normalized))) * 1;
}
