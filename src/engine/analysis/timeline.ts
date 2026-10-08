import type { SceneTracks, TimelineTrack } from "#/engine/model";
import { toSeconds } from "#/engine/time";
import { SILENCE_FLOOR_DB, powerToDb } from "./audio";
import type {
  LevelCurve, LoudnessWindow, PacingBucket, TimeRange, TimelineAnalysis, TimelineClipInput, TimelineTrackInput, TimelineTrackKind, TrackPacing,
} from "./types";

export const PACING_BUCKET_BOUNDS_SECONDS: ReadonlyArray<number> = [0, 1, 2, 4, 8, 16];
export const LOUDNESS_WINDOW_SECONDS = 1;
const EPSILON = 1e-9;

const KIND_OF: Record<TimelineTrack["type"], TimelineTrackKind> = {
  video: "video", audio: "audio", text: "text", graphic: "graphic", effect: "effect",
};

/** Converts engine tracks (ticks) to analysis input (seconds). Hidden/muted state is ignored; filter first if it matters. */
export function trackInputsFromScene(tracks: SceneTracks): TimelineTrackInput[] {
  const all: TimelineTrack[] = [...tracks.overlay, tracks.main, ...tracks.audio];
  return all.map((track) => ({
    id: track.id,
    kind: KIND_OF[track.type],
    clips: (track.elements as ReadonlyArray<TimelineTrack["elements"][number]>).map((element) => {
      const rate = "retime" in element ? (element.retime?.rate ?? 1) : 1;
      return {
        id: element.id,
        mediaId: "mediaId" in element ? element.mediaId : undefined,
        start: toSeconds(element.startTime),
        end: toSeconds(element.startTime + element.duration),
        trimStart: toSeconds(element.trimStart),
        rate,
      };
    }),
  }));
}

export function mergeRanges(ranges: ReadonlyArray<TimeRange>): TimeRange[] {
  const sorted = [...ranges].sort((a, b) => a.start - b.start);
  const out: TimeRange[] = [];
  for (const range of sorted) {
    const last = out[out.length - 1];
    if (last && range.start <= last.end + EPSILON) last.end = Math.max(last.end, range.end);
    else out.push({ ...range });
  }
  return out;
}

function pacingHistogram(lengths: ReadonlyArray<number>): PacingBucket[] {
  const bounds = PACING_BUCKET_BOUNDS_SECONDS;
  const buckets: PacingBucket[] = bounds.map((min, i) => ({ minSeconds: min, maxSeconds: bounds[i + 1] ?? null, count: 0 }));
  for (const length of lengths) {
    let index = bounds.length - 1;
    while (index > 0 && length < (bounds[index] as number)) index--;
    (buckets[index] as PacingBucket).count++;
  }
  return buckets;
}

function countOverlaps(tracks: ReadonlyArray<TimelineTrackInput>): number {
  const clips = tracks.flatMap((t) => t.clips.map((c) => ({ track: t.id, start: c.start, end: c.end })));
  clips.sort((a, b) => a.start - b.start);
  let count = 0;
  for (let i = 0; i < clips.length; i++) {
    const a = clips[i] as (typeof clips)[number];
    for (let j = i + 1; j < clips.length; j++) {
      const b = clips[j] as (typeof clips)[number];
      if (b.start >= a.end - EPSILON) break;
      if (a.track !== b.track && Math.min(a.end, b.end) - b.start > EPSILON) count++;
    }
  }
  return count;
}

const mean = (values: ReadonlyArray<number>): number => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0);

/**
 * Pacing facts for a timeline. "Shots" are clips on video-kind tracks (main and overlay video);
 * a cut is a distinct clip start on those tracks after the earliest one. Dead air is time inside
 * [0, duration] where no video or audio clip is active.
 */
export function analyzeTimelinePacing(tracks: ReadonlyArray<TimelineTrackInput>): TimelineAnalysis {
  const durationSeconds = tracks.reduce((m, t) => t.clips.reduce((mm, c) => Math.max(mm, c.end), m), 0);
  const perTrack: TrackPacing[] = tracks.map((track) => {
    const clips = [...track.clips].sort((a, b) => a.start - b.start);
    const cutLengths = clips.map((c) => c.end - c.start);
    let gapSeconds = 0;
    for (let i = 1; i < clips.length; i++) gapSeconds += Math.max(0, (clips[i] as TimelineClipInput).start - (clips[i - 1] as TimelineClipInput).end);
    return { trackId: track.id, kind: track.kind, clipCount: clips.length, cutLengths, averageLength: mean(cutLengths), gapSeconds };
  });

  const videoClips = tracks.filter((t) => t.kind === "video").flatMap((t) => t.clips);
  const videoLengths = videoClips.map((c) => c.end - c.start);
  const starts = [...new Set(videoClips.map((c) => c.start))].sort((a, b) => a - b);
  const cutCount = Math.max(0, starts.length - 1);

  const covered = mergeRanges(tracks.filter((t) => t.kind === "video" || t.kind === "audio").flatMap((t) => t.clips.map((c) => ({ start: c.start, end: c.end }))));
  const deadAirRanges: TimeRange[] = [];
  let cursor = 0;
  for (const range of covered) {
    if (range.start > cursor + EPSILON) deadAirRanges.push({ start: cursor, end: range.start });
    cursor = Math.max(cursor, range.end);
  }
  if (durationSeconds > cursor + EPSILON) deadAirRanges.push({ start: cursor, end: durationSeconds });

  return {
    durationSeconds,
    tracks: perTrack,
    averageShotLength: mean(videoLengths),
    pacingHistogram: pacingHistogram(videoLengths),
    cutsPerMinute: durationSeconds > 0 ? cutCount / (durationSeconds / 60) : 0,
    deadAirSeconds: deadAirRanges.reduce((a, r) => a + (r.end - r.start), 0),
    deadAirRanges,
    overlapCount: countOverlaps(tracks),
  };
}

function meanSquareOverSource(curve: LevelCurve, from: number, to: number): number {
  if (to <= from) return 0;
  const first = Math.max(0, Math.floor(from / curve.windowSeconds));
  const last = Math.min(curve.db.length - 1, Math.floor((to - EPSILON) / curve.windowSeconds));
  let weighted = 0;
  let covered = 0;
  for (let i = first; i <= last; i++) {
    const overlap = Math.min(to, (i + 1) * curve.windowSeconds) - Math.max(from, i * curve.windowSeconds);
    if (overlap <= 0) continue;
    weighted += overlap * 10 ** ((curve.db[i] as number) / 10);
    covered += overlap;
  }
  return covered > 0 ? weighted / covered : 0;
}

/**
 * Loudness of the timeline in fixed windows: active audio clips are summed as incoherent power
 * using each asset's level curve. Ignores clip gain, fades and mute state (apply before calling).
 */
export function timelineLoudness(input: {
  tracks: ReadonlyArray<TimelineTrackInput>;
  curves: ReadonlyMap<string, LevelCurve>;
  windowSeconds?: number;
}): LoudnessWindow[] {
  const windowSeconds = input.windowSeconds ?? LOUDNESS_WINDOW_SECONDS;
  const clips = input.tracks.filter((t) => t.kind === "audio" || t.kind === "video").flatMap((t) => t.clips);
  const duration = clips.reduce((m, c) => Math.max(m, c.end), 0);
  const out: LoudnessWindow[] = [];
  for (let start = 0; start < duration - EPSILON; start += windowSeconds) {
    const end = Math.min(duration, start + windowSeconds);
    let power = 0;
    for (const clip of clips) {
      const curve = clip.mediaId ? input.curves.get(clip.mediaId) : undefined;
      if (!curve) continue;
      const a = Math.max(start, clip.start);
      const b = Math.min(end, clip.end);
      if (b - a <= EPSILON) continue;
      const rate = clip.rate ?? 1;
      const sourceFrom = (clip.trimStart ?? 0) + (a - clip.start) * rate;
      const sourceTo = (clip.trimStart ?? 0) + (b - clip.start) * rate;
      power += ((b - a) / (end - start)) * meanSquareOverSource(curve, sourceFrom, sourceTo);
    }
    out.push({ start, end, db: power > 0 ? powerToDb(power) : SILENCE_FLOOR_DB });
  }
  return out;
}
