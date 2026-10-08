import type { TimeRange, TimelineAnalysis } from "#/engine/analysis";
import { beatLockScore } from "./beats";
import { mean, quantileSorted } from "./stats";
import type { StyleProfile } from "./types";

const RELATIVE_TOLERANCE = 0.25;
const HOOK_TOLERANCE = 0.4;
const BEAT_LOCK_TOLERANCE = 0.15;
const DEAD_AIR_NOTICE_SECONDS = 0.5;

export interface StyleDelta {
  metric: "averageShotSeconds" | "medianShotSeconds" | "cutsPerMinute" | "hookSeconds" | "beatLockScore" | "textClipsPerMinute" | "deadAirSeconds";
  actual: number;
  target: number;
  withinTolerance: boolean;
  /** Plain English with both numbers, e.g. "average shot 4.2s vs target 1.8s". */
  message: string;
}

export interface StyleComparison {
  deltas: StyleDelta[];
  /** Share of compared metrics within tolerance, 0..1. */
  matchScore: number;
}

export interface CompareOptions {
  /** Start of every distinct video clip, ascending (first included). Enables hook and beat-lock deltas. */
  shotStarts?: ReadonlyArray<number>;
  /** End of the last video clip; cuts per minute is measured over this span instead of the whole timeline (music may run longer). */
  videoSeconds?: number;
  /** Beat times on the timeline, ascending. Without them beat lock is not compared. */
  beats?: ReadonlyArray<number>;
  /** Text clips on the timeline; enables the text-density delta when the profile has text. */
  textClips?: ReadonlyArray<TimeRange>;
}

const round = (value: number, digits = 1): number => {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
};
const relativeGap = (actual: number, target: number): number => (target === 0 ? (actual === 0 ? 0 : Infinity) : Math.abs(actual - target) / target);
const signedPercent = (actual: number, target: number): string =>
  target === 0 ? "" : ` (${actual >= target ? "+" : "-"}${Math.round(relativeGap(actual, target) * 100)}%)`;

function numeric(input: {
  metric: StyleDelta["metric"]; label: string; unit: string; actual: number; target: number; tolerance: number;
}): StyleDelta {
  const { actual, target } = input;
  return {
    metric: input.metric,
    actual,
    target,
    withinTolerance: relativeGap(actual, target) <= input.tolerance,
    message: `${input.label} ${round(actual)}${input.unit} vs target ${round(target)}${input.unit}${signedPercent(actual, target)}`,
  };
}

/** Measurable deltas between a timeline's pacing and a style profile. Only metrics that can be measured are reported. */
export function compareToProfile(timeline: TimelineAnalysis, profile: StyleProfile, options: CompareOptions = {}): StyleComparison {
  const deltas: StyleDelta[] = [];
  const starts = options.shotStarts ?? [];
  const cutsPerMinute = options.videoSeconds !== undefined && options.videoSeconds > 0 && starts.length >= 1
    ? (starts.length - 1) / (options.videoSeconds / 60)
    : timeline.cutsPerMinute;
  const lengths = timeline.tracks.filter((t) => t.kind === "video").flatMap((t) => t.cutLengths).sort((a, b) => a - b);
  if (lengths.length > 0) {
    deltas.push(numeric({ metric: "averageShotSeconds", label: "average shot", unit: "s", actual: mean(lengths), target: profile.shots.meanSeconds, tolerance: RELATIVE_TOLERANCE }));
    deltas.push(numeric({ metric: "medianShotSeconds", label: "median shot", unit: "s", actual: quantileSorted(lengths, 0.5), target: profile.shots.medianSeconds, tolerance: RELATIVE_TOLERANCE }));
    deltas.push(numeric({ metric: "cutsPerMinute", label: "cuts per minute", unit: "", actual: cutsPerMinute, target: profile.shots.cutsPerMinute, tolerance: RELATIVE_TOLERANCE }));
  }
  if (starts.length >= 2) {
    deltas.push(numeric({ metric: "hookSeconds", label: "opening shot", unit: "s", actual: (starts[1] as number) - (starts[0] as number), target: profile.shots.hookSeconds, tolerance: HOOK_TOLERANCE }));
  }
  if (starts.length >= 2 && options.beats && options.beats.length > 0 && profile.beatLock.beatsAvailable) {
    const { hits, total } = beatLockScore({ cuts: starts.slice(1), beats: options.beats, tolerance: profile.beatLock.toleranceSeconds });
    const actual = hits / total;
    const target = profile.beatLock.score;
    const ms = Math.round(profile.beatLock.toleranceSeconds * 1000);
    deltas.push({
      metric: "beatLockScore",
      actual,
      target,
      withinTolerance: Math.abs(actual - target) <= BEAT_LOCK_TOLERANCE,
      message: `${actual < target ? "only " : ""}${Math.round(actual * 100)}% of cuts within ${ms}ms of a beat vs ${Math.round(target * 100)}%`,
    });
  }
  if (profile.text && options.textClips) {
    const minutes = timeline.durationSeconds / 60;
    deltas.push(numeric({
      metric: "textClipsPerMinute", label: "text clips per minute", unit: "",
      actual: minutes > 0 ? options.textClips.length / minutes : 0, target: profile.text.clipsPerMinute, tolerance: RELATIVE_TOLERANCE,
    }));
  }
  if (timeline.deadAirSeconds > DEAD_AIR_NOTICE_SECONDS) {
    deltas.push({
      metric: "deadAirSeconds", actual: timeline.deadAirSeconds, target: 0, withinTolerance: false,
      message: `dead air ${round(timeline.deadAirSeconds)}s vs target 0s`,
    });
  }
  const matched = deltas.filter((d) => d.withinTolerance).length;
  return { deltas, matchScore: deltas.length === 0 ? 0 : matched / deltas.length };
}
