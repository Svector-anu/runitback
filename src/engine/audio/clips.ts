import { TICKS_PER_SECOND } from "#/engine/time";
import {
  clampDb, dbToLinear, orderedTracks, numberParam, boolParam, PARAM, type MediaAssetInfo, type SceneTracks, type TimelineElement,
} from "#/engine/model";
import { listKeyframes, resolveNumberAtTime } from "#/engine/animation";
import { curveSegments, effectiveRate } from "#/engine/timeline";
import { clipHasAudible } from "./gain";

/** One audible span of the timeline, in seconds, ready to be scheduled on an audio clock. */
export interface AudioClip {
  key: string;
  mediaId: string;
  /** Timeline seconds. */
  start: number;
  duration: number;
  /** Source seconds trimmed from the head. */
  trimStart: number;
  rate: number;
  maintainPitch: boolean;
  /** Linear gain at `localSeconds` into the clip; 0 when muted. */
  gainAt(localSeconds: number): number;
  /** True when gain varies over time and needs automation. */
  animated: boolean;
  constantGain: number;
}

const seconds = (ticks: number): number => ticks / TICKS_PER_SECOND;

/** Longest stretch of one scheduled piece of a speed-ramped clip. */
const RAMP_SEGMENT_TICKS = 0.5 * TICKS_PER_SECOND;

/**
 * A ramped clip is scheduled as consecutive constant-rate pieces whose ends sit exactly on the speed curve, so audio
 * follows the ramp (stepwise, at most 15% rate change per piece) and never drifts from the picture.
 */
function rampPieces(clip: AudioClip, element: TimelineElement): AudioClip[] {
  const curve = "retime" in element ? element.retime?.curve : undefined;
  if (!curve) return [clip];
  return curveSegments({ curve, trimStart: element.trimStart, duration: element.duration, maxSegmentTicks: RAMP_SEGMENT_TICKS }).map((segment, index) => ({
    ...clip,
    key: `${clip.key}#${index}`,
    start: clip.start + seconds(segment.clipOffset),
    duration: seconds(segment.duration),
    trimStart: seconds(segment.sourceStart),
    rate: segment.rate,
    gainAt: (localSeconds: number) => clip.gainAt(seconds(segment.clipOffset) + localSeconds),
  }));
}

function clipFor(input: { element: TimelineElement; trackId: string; trackMuted: boolean }): AudioClip | null {
  const { element } = input;
  if (element.type !== "audio" && element.type !== "video") return null;
  if (input.trackMuted || !clipHasAudible(element)) return null;
  if (boolParam(element.params, PARAM.muted, false)) return null;
  const baseDb = numberParam(element.params, PARAM.volume, 0);
  const animated = listKeyframes(element.animations).some((k) => k.path === PARAM.volume);
  const gainAt = (localSeconds: number): number => {
    const db = animated ? resolveNumberAtTime(element.animations, PARAM.volume, localSeconds * TICKS_PER_SECOND, baseDb) : baseDb;
    return dbToLinear(clampDb(db));
  };
  const retime = element.retime;
  return {
    key: `${input.trackId}/${element.id}`, mediaId: element.mediaId,
    start: seconds(element.startTime), duration: seconds(element.duration), trimStart: seconds(element.trimStart),
    rate: effectiveRate(retime), maintainPitch: retime?.maintainPitch === true,
    gainAt, animated, constantGain: dbToLinear(clampDb(baseDb)),
  };
}

/** Every clip that makes sound: audio elements and videos whose own audio is still enabled and present. */
export function collectAudioClips(input: { tracks: SceneTracks; assets: ReadonlyArray<MediaAssetInfo> }): AudioClip[] {
  const assets = new Map(input.assets.map((a) => [a.id, a]));
  const clips: AudioClip[] = [];
  for (const track of orderedTracks(input.tracks)) {
    if (track.type !== "audio" && track.type !== "video") continue;
    for (const element of track.elements as TimelineElement[]) {
      if (element.type === "video" && assets.get(element.mediaId)?.hasAudio === false) continue;
      const clip = clipFor({ element, trackId: track.id, trackMuted: track.muted });
      if (clip) clips.push(...rampPieces(clip, element));
    }
  }
  return clips;
}

/** Gain automation points (timeline seconds, linear) over [from, to]; a single point for constant gain. */
export function gainEnvelope(input: { clip: AudioClip; from: number; to: number; step?: number }): Array<{ time: number; gain: number }> {
  const { clip } = input;
  const from = Math.max(input.from, clip.start);
  const to = Math.min(input.to, clip.start + clip.duration);
  if (!clip.animated) return [{ time: from, gain: clip.constantGain }];
  const step = input.step ?? 0.05;
  const points: Array<{ time: number; gain: number }> = [];
  for (let t = from; t < to; t += step) points.push({ time: t, gain: clip.gainAt(t - clip.start) });
  points.push({ time: to, gain: clip.gainAt(to - clip.start) });
  return points;
}

/** Source-time span consumed by a timeline window [from, to] of a clip. */
export function sourceWindow(input: { clip: AudioClip; from: number; to: number }): { start: number; end: number; timelineStart: number; timelineEnd: number } | null {
  const { clip } = input;
  const a = Math.max(input.from, clip.start);
  const b = Math.min(input.to, clip.start + clip.duration);
  if (b <= a) return null;
  return {
    start: clip.trimStart + (a - clip.start) * clip.rate,
    end: clip.trimStart + (b - clip.start) * clip.rate,
    timelineStart: a,
    timelineEnd: b,
  };
}
