import { PACING_BUCKET_BOUNDS_SECONDS, SILENCE_FLOOR_DB, mergeRanges, type MediaAnalysis, type TimeRange } from "#/engine/analysis";
import { beatLockScore, beatTimes } from "./beats";
import { clamp, mean, quantileSorted } from "./stats";
import {
  STYLE_PROFILE_VERSION, type AudioStyle, type BeatLock, type ColourStyle, type CutDensity, type CutTrend, type LengthBin,
  type LoudnessShape, type RhythmClass, type ShotStats, type StyleProfile, type StyleProfileOptions, type TextStyle,
} from "./types";

export const QUANTILE_LEVELS: ReadonlyArray<number> = Array.from({ length: 21 }, (_, i) => i / 20);
export const DEFAULT_BEAT_TOLERANCE_SECONDS = 0.08;
export const FAST_MONTAGE_MAX_MEDIAN_SECONDS = 1.5;
export const STEADY_MAX_MEDIAN_SECONDS = 4;
const TREND_RATIO = 1.25;
const SHAPE_STEP_DB = 3;
const PALETTE_SIZE = 5;
const COLOUR_RANK_WEIGHTS = [3, 2, 1];
const COLOUR_BUCKET = 32;

export function rhythmOf(medianSeconds: number): RhythmClass {
  if (medianSeconds < FAST_MONTAGE_MAX_MEDIAN_SECONDS) return "fast-montage";
  return medianSeconds <= STEADY_MAX_MEDIAN_SECONDS ? "steady" : "slow-burn";
}

/** Shot ranges of one analysis: measured shots, else scene cuts, else the whole file as one shot. */
export function shotRangesOf(analysis: MediaAnalysis): TimeRange[] {
  if (analysis.shots.length > 0) {
    return [...analysis.shots].sort((a, b) => a.start - b.start).map((s) => ({ start: s.start, end: s.end })).filter((r) => r.end > r.start);
  }
  const cuts = [...new Set(analysis.sceneCuts.map((c) => c.time))].filter((t) => t > 0 && t < analysis.durationSeconds).sort((a, b) => a - b);
  const bounds = [0, ...cuts, analysis.durationSeconds];
  const ranges: TimeRange[] = [];
  for (let i = 0; i + 1 < bounds.length; i++) ranges.push({ start: bounds[i] as number, end: bounds[i + 1] as number });
  return ranges.filter((r) => r.end > r.start);
}

function histogram(lengths: ReadonlyArray<number>): LengthBin[] {
  const bounds = PACING_BUCKET_BOUNDS_SECONDS;
  const bins = bounds.map((min, i) => ({ minSeconds: min, maxSeconds: bounds[i + 1] ?? null, count: 0 }));
  for (const length of lengths) {
    let index = bounds.length - 1;
    while (index > 0 && length < (bounds[index] as number)) index--;
    (bins[index] as { count: number }).count++;
  }
  return bins.map((b) => ({ minSeconds: b.minSeconds, maxSeconds: b.maxSeconds, fraction: lengths.length === 0 ? 0 : b.count / lengths.length }));
}

function trendOf(opening: number, end: number): CutTrend {
  if (opening > end * TREND_RATIO) return "decelerating";
  if (end > opening * TREND_RATIO) return "accelerating";
  return "steady";
}

interface VideoSource {
  analysis: MediaAnalysis;
  ranges: TimeRange[];
  /** Cut times: start of every shot after the first. */
  cuts: number[];
}

function shotStats(sources: ReadonlyArray<VideoSource>, totalSeconds: number): ShotStats {
  const lengths = sources.flatMap((s) => s.ranges.map((r) => r.end - r.start));
  const sorted = [...lengths].sort((a, b) => a - b);
  const medianSeconds = quantileSorted(sorted, 0.5);
  const cutCount = sources.reduce((n, s) => n + s.cuts.length, 0);
  return {
    count: lengths.length,
    meanSeconds: mean(lengths),
    medianSeconds,
    p10Seconds: quantileSorted(sorted, 0.1),
    p90Seconds: quantileSorted(sorted, 0.9),
    quantiles: QUANTILE_LEVELS.map((q) => quantileSorted(sorted, q)),
    histogram: histogram(lengths),
    rhythm: rhythmOf(medianSeconds),
    cutsPerMinute: totalSeconds > 0 ? cutCount / (totalSeconds / 60) : 0,
    hookSeconds: mean(sources.map((s) => (s.ranges[0] as TimeRange).end - (s.ranges[0] as TimeRange).start)),
  };
}

function cutDensity(sources: ReadonlyArray<VideoSource>): CutDensity {
  const counts = [0, 0, 0];
  let thirdSeconds = 0;
  for (const { analysis, cuts } of sources) {
    const duration = analysis.durationSeconds;
    thirdSeconds += duration / 3;
    for (const cut of cuts) counts[Math.min(2, Math.floor((cut / duration) * 3))]!++;
  }
  const perMinute = (count: number): number => (thirdSeconds > 0 ? count / (thirdSeconds / 60) : 0);
  const [opening, middle, end] = counts.map(perMinute) as [number, number, number];
  return { openingPerMinute: opening, middlePerMinute: middle, endPerMinute: end, trend: trendOf(opening, end) };
}

function beatLock(sources: ReadonlyArray<VideoSource>, tolerance: number): BeatLock {
  let hits = 0;
  let total = 0;
  let beatsAvailable = false;
  let best: { bpm: number; confidence: number } | null = null;
  for (const { analysis, cuts } of sources) {
    const beats = beatTimes(analysis);
    if (beats.length > 0) {
      beatsAvailable = true;
      const result = beatLockScore({ cuts, beats, tolerance });
      hits += result.hits;
      total += result.total;
    }
    if (analysis.tempoBpm !== undefined && (!best || (analysis.tempoConfidence ?? 0) > best.confidence)) {
      best = { bpm: analysis.tempoBpm, confidence: analysis.tempoConfidence ?? 0 };
    }
  }
  return {
    score: total === 0 ? 0 : hits / total,
    toleranceSeconds: tolerance,
    tempoBpm: best ? best.bpm : null,
    tempoConfidence: best ? best.confidence : 0,
    cutsMeasured: total,
    beatsAvailable,
  };
}

function shapeOf([first, middle, last]: [number, number, number]): LoudnessShape {
  if (middle - Math.max(first, last) >= SHAPE_STEP_DB) return "peaked";
  if (Math.min(first, last) - middle >= SHAPE_STEP_DB) return "dipped";
  if (last - first >= SHAPE_STEP_DB) return "rising";
  if (first - last >= SHAPE_STEP_DB) return "falling";
  return "flat";
}

function audioStyle(analyses: ReadonlyArray<MediaAnalysis>): AudioStyle | null {
  const audible = analyses.filter((a) => a.hasAudio);
  if (audible.length === 0) return null;
  const duration = audible.reduce((n, a) => n + a.durationSeconds, 0);
  const silent = audible.reduce((n, a) => n + a.silences.reduce((m, s) => m + (s.end - s.start), 0), 0);
  const curves = audible.flatMap((a) => (a.levelCurve && a.levelCurve.db.length >= 3 ? [a.levelCurve.db] : []));
  const thirds = curves.map((db): [number, number, number] => {
    const cut = Math.floor(db.length / 3);
    return [mean(db.slice(0, cut)), mean(db.slice(cut, db.length - cut)), mean(db.slice(db.length - cut))];
  });
  const pooled = curves.flat().filter((v) => v > SILENCE_FLOOR_DB).sort((a, b) => a - b);
  const integrated = audible.flatMap((a) => (a.loudness ? [a.loudness.integratedApproxDb] : []));
  return {
    loudnessShape: thirds.length === 0 ? null : shapeOf([mean(thirds.map((t) => t[0])), mean(thirds.map((t) => t[1])), mean(thirds.map((t) => t[2]))]),
    silenceRatio: duration > 0 ? clamp(silent / duration, 0, 1) : 0,
    dynamicRangeDb: pooled.length === 0 ? null : quantileSorted(pooled, 0.95) - quantileSorted(pooled, 0.1),
    integratedApproxDb: integrated.length === 0 ? null : mean(integrated),
  };
}

interface Rgb { r: number; g: number; b: number }

function parseHex(hex: string): Rgb | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const n = Number.parseInt(m[1] as string, 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

const toHex = ({ r, g, b }: Rgb): string => `#${[r, g, b].map((v) => Math.round(v).toString(16).padStart(2, "0")).join("")}`;
const luma = ({ r, g, b }: Rgb): number => (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
const saturationOf = ({ r, g, b }: Rgb): number => {
  const max = Math.max(r, g, b);
  return max === 0 ? 0 : (max - Math.min(r, g, b)) / max;
};

function colourStyle(analyses: ReadonlyArray<MediaAnalysis>): ColourStyle | null {
  const weighted: Array<{ rgb: Rgb; weight: number }> = [];
  const primaries: Rgb[] = [];
  for (const analysis of analyses) {
    for (const shot of analysis.shots) {
      shot.dominantColors.forEach((hex, rank) => {
        const rgb = parseHex(hex);
        if (!rgb) return;
        weighted.push({ rgb, weight: COLOUR_RANK_WEIGHTS[rank] ?? 1 });
        if (rank === 0) primaries.push(rgb);
      });
    }
  }
  if (weighted.length === 0) return null;
  const buckets = new Map<string, number>();
  for (const { rgb, weight } of weighted) {
    const key = [rgb.r, rgb.g, rgb.b].map((v) => Math.floor(v / COLOUR_BUCKET)).join(",");
    buckets.set(key, (buckets.get(key) ?? 0) + weight);
  }
  const palette = [...buckets.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, PALETTE_SIZE)
    .map(([key]) => {
      const [r, g, b] = key.split(",").map((v) => Number(v) * COLOUR_BUCKET + COLOUR_BUCKET / 2) as [number, number, number];
      return toHex({ r, g, b });
    });
  const totalWeight = weighted.reduce((n, w) => n + w.weight, 0);
  const lumas = primaries.map(luma);
  const average = mean(lumas);
  const deviation = Math.sqrt(mean(lumas.map((l) => (l - average) ** 2)));
  return {
    palette,
    contrast: clamp(deviation * 2, 0, 1),
    saturation: weighted.reduce((n, w) => n + saturationOf(w.rgb) * w.weight, 0) / totalWeight,
    brightness: weighted.reduce((n, w) => n + luma(w.rgb) * w.weight, 0) / totalWeight,
  };
}

function textStyle(clips: ReadonlyArray<TimeRange>, totalSeconds: number): TextStyle {
  const durations = clips.map((c) => c.end - c.start);
  const covered = mergeRanges(clips).reduce((n, r) => n + (r.end - r.start), 0);
  return {
    clipsPerMinute: totalSeconds > 0 ? clips.length / (totalSeconds / 60) : 0,
    meanDurationSeconds: mean(durations),
    coverage: totalSeconds > 0 ? clamp(covered / totalSeconds, 0, 1) : 0,
  };
}

/**
 * Condenses measured analyses of one or more reference videos into a style profile. Shot statistics are pooled
 * across sources (every shot counts once); per-source quantities such as beat lock use each source's own audio.
 * Throws when no analysis contains a video shot.
 */
export function buildStyleProfile(analyses: ReadonlyArray<MediaAnalysis>, options: StyleProfileOptions = {}): StyleProfile {
  const video = analyses.filter((a) => a.hasVideo && a.durationSeconds > 0);
  const sources: VideoSource[] = video.map((analysis) => {
    const ranges = shotRangesOf(analysis);
    return { analysis, ranges, cuts: ranges.slice(1).map((r) => r.start) };
  }).filter((s) => s.ranges.length > 0);
  if (sources.length === 0) throw new Error("No analysis contains a video with a measurable duration, so there is nothing to build a style from.");
  const totalSeconds = sources.reduce((n, s) => n + s.analysis.durationSeconds, 0);
  const used = sources.map((s) => s.analysis);
  return {
    version: STYLE_PROFILE_VERSION,
    sourceIds: used.map((a) => a.assetId),
    totalSeconds,
    shots: shotStats(sources, totalSeconds),
    cutDensity: cutDensity(sources),
    beatLock: beatLock(sources, options.beatToleranceSeconds ?? DEFAULT_BEAT_TOLERANCE_SECONDS),
    audio: audioStyle(used),
    colour: colourStyle(used),
    text: options.textClips && options.textClips.length > 0 ? textStyle(options.textClips, totalSeconds) : null,
  };
}
