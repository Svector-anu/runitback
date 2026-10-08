import { DEFAULT_SILENCE_MIN_SECONDS, LEVEL_CURVE_WINDOW_SECONDS, MEDIA_ANALYSIS_VERSION, type MediaAnalysis, type ShotAnalysis } from "#/engine/analysis";
import type { MediaAssetInfo } from "#/engine/model";
import { DEFAULT_FPS, mediaTimeFromSeconds } from "#/engine/time";
import type { ColorBlock, FixtureSpec, FixtureTruth, Range, ResolvedFixture } from "./types";

export const FIXTURE_WIDTH = 1920;
export const FIXTURE_HEIGHT = 1080;
const GREY_BLOCK_RGB: [number, number, number] = [128, 128, 128];
const SOUND_LEVEL_DB = -20;
const SILENCE_LEVEL_DB = -90;
const SPEECH_ONSET_STRENGTH = 0.6;

const EPSILON = 1e-9;

export function mergeRanges(ranges: ReadonlyArray<Range>): Range[] {
  const sorted = ranges.filter((r) => r.end - r.start > EPSILON).map((r) => ({ ...r })).sort((a, b) => a.start - b.start);
  const out: Range[] = [];
  for (const range of sorted) {
    const last = out[out.length - 1];
    if (last && range.start <= last.end + EPSILON) last.end = Math.max(last.end, range.end);
    else out.push(range);
  }
  return out;
}

/** The parts of [0, duration] not covered by `ranges`. */
export function complementOf(ranges: ReadonlyArray<Range>, duration: number): Range[] {
  const out: Range[] = [];
  let cursor = 0;
  for (const range of mergeRanges(ranges)) {
    if (range.start > cursor + EPSILON) out.push({ start: cursor, end: Math.min(range.start, duration) });
    cursor = Math.max(cursor, range.end);
  }
  if (duration > cursor + EPSILON) out.push({ start: cursor, end: duration });
  return out.filter((r) => r.end - r.start > EPSILON);
}

export function hasAudio(spec: FixtureSpec): boolean {
  return spec.audio.kind !== "none";
}

export function blocksOf(spec: FixtureSpec): ColorBlock[] {
  return spec.blocks ?? [{ seconds: spec.durationSeconds, rgb: GREY_BLOCK_RGB }];
}

export function shotsOf(spec: FixtureSpec): Range[] {
  if (spec.kind !== "video") return [];
  let cursor = 0;
  return blocksOf(spec).map((b) => {
    const shot = { start: cursor, end: cursor + b.seconds };
    cursor = shot.end;
    return shot;
  });
}

export function beatsOf(spec: FixtureSpec): number[] {
  if (spec.audio.kind !== "beat") return [];
  const period = 60 / spec.audio.bpm;
  const beats: number[] = [];
  for (let t = spec.audio.phase; t < spec.durationSeconds - EPSILON; t += period) beats.push(Math.round(t * 1e6) / 1e6);
  return beats;
}

/** Exact ground truth, straight from the declaration. */
export function truthFromSpec(spec: FixtureSpec): FixtureTruth {
  const duration = spec.durationSeconds;
  let sound: Range[] = [];
  if (spec.audio.kind === "speech") sound = mergeRanges(spec.audio.speech.map((r) => ({ start: Math.max(0, r.start), end: Math.min(duration, r.end) })));
  else if (spec.audio.kind === "tone" || spec.audio.kind === "beat") sound = [{ start: 0, end: duration }];
  return {
    durationSeconds: duration,
    hasAudio: hasAudio(spec),
    sound,
    silences: hasAudio(spec) ? complementOf(sound, duration) : [],
    beats: beatsOf(spec),
    shots: shotsOf(spec),
  };
}

/** Ground truth read back from a real measurement of the generated media (silences below the detector's minimum count as sound). */
export function truthFromAnalysis(spec: FixtureSpec, analysis: MediaAnalysis): FixtureTruth {
  const duration = analysis.durationSeconds;
  const silences = analysis.hasAudio ? mergeRanges(analysis.silences.map((s) => ({ start: s.start, end: s.end }))) : [];
  return {
    durationSeconds: duration,
    hasAudio: analysis.hasAudio,
    sound: analysis.hasAudio ? complementOf(silences, duration) : [],
    silences,
    beats: spec.audio.kind === "beat" ? analysis.onsets.map((o) => o.time) : [],
    shots: analysis.shots.map((s) => ({ start: s.start, end: s.end })),
  };
}

export function assetInfoOf(spec: FixtureSpec): MediaAssetInfo {
  const base: MediaAssetInfo = {
    id: spec.id, name: spec.name, type: spec.kind, size: 1, lastModified: 0, duration: mediaTimeFromSeconds(spec.durationSeconds),
    hasAudio: hasAudio(spec),
  };
  return spec.kind === "video" ? { ...base, width: FIXTURE_WIDTH, height: FIXTURE_HEIGHT, fps: DEFAULT_FPS } : base;
}

const hex = (n: number): string => n.toString(16).padStart(2, "0");
export const rgbToHex = (rgb: readonly [number, number, number]): string => `#${hex(rgb[0])}${hex(rgb[1])}${hex(rgb[2])}`;

function levelCurveOf(sound: ReadonlyArray<Range>, duration: number): number[] {
  const windows = Math.ceil(duration / LEVEL_CURVE_WINDOW_SECONDS - EPSILON);
  return Array.from({ length: windows }, (_, i) => {
    const from = i * LEVEL_CURVE_WINDOW_SECONDS;
    const to = from + LEVEL_CURVE_WINDOW_SECONDS;
    const covered = sound.reduce((sum, r) => sum + Math.max(0, Math.min(to, r.end) - Math.max(from, r.start)), 0);
    return covered >= LEVEL_CURVE_WINDOW_SECONDS / 2 ? SOUND_LEVEL_DB : SILENCE_LEVEL_DB;
  });
}

/** The analysis the real analyzer would report for the declared media, without decoding anything. */
export function analysisFromSpec(spec: FixtureSpec): MediaAnalysis {
  const truth = truthFromSpec(spec);
  const duration = spec.durationSeconds;
  const audible = truth.hasAudio;
  const blocks = blocksOf(spec);
  const shots: ShotAnalysis[] = spec.kind === "video"
    ? truth.shots.map((range, i) => ({ ...range, motion: "low", motionScore: 0.02, dominantColors: [rgbToHex((blocks[i] as ColorBlock).rgb)] }))
    : [];
  const onsets = spec.audio.kind === "beat"
    ? truth.beats.map((time) => ({ time, strength: 1 }))
    : spec.audio.kind === "speech" ? truth.sound.map((r) => ({ time: r.start, strength: SPEECH_ONSET_STRENGTH })) : [];
  return {
    assetId: spec.id,
    version: MEDIA_ANALYSIS_VERSION,
    durationSeconds: duration,
    hasAudio: audible,
    hasVideo: spec.kind === "video",
    silences: truth.silences.filter((r) => r.end - r.start >= DEFAULT_SILENCE_MIN_SECONDS).map((r) => ({ ...r, meanDb: SILENCE_LEVEL_DB })),
    loudness: audible ? { peakDb: -10, rmsDb: -20, integratedApproxDb: -18 } : null,
    speechLikeRanges: spec.audio.kind === "speech" ? truth.sound : [],
    onsets,
    ...(spec.audio.kind === "beat" ? { tempoBpm: spec.audio.bpm, tempoConfidence: 0.95 } : {}),
    levelCurve: audible ? { windowSeconds: LEVEL_CURVE_WINDOW_SECONDS, db: levelCurveOf(truth.sound, duration) } : null,
    sceneCuts: shots.slice(1).map((s) => ({ time: s.start, score: 0.9 })),
    shots,
    notes: ["Synthetic analysis computed from the fixture declaration."],
  };
}

export function resolveFixtures(specs: ReadonlyArray<FixtureSpec>, assetIdOf: (spec: FixtureSpec) => string = (s) => s.id): ResolvedFixture[] {
  return specs.map((spec) => ({ spec, assetId: assetIdOf(spec), truth: truthFromSpec(spec) }));
}
