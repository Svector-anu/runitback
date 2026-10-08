import type { LoudnessWindow, MediaAnalysis, TimelineAnalysis, TimeRange } from "#/engine/analysis";

/** Hard caps keep every analysis result small enough to be cheap in a model context. */
export const SUMMARY_LIMITS = {
  silences: 20,
  cuts: 40,
  shots: 20,
  speech: 15,
  onsets: 12,
  deadAir: 10,
  loudnessWindows: 90,
  tracks: 12,
} as const;

export const SHEET_MAX_SIDE_PX = 1024;
export const SHEET_MAX_FRAMES = 16;
export const SHEET_GAP_PX = 4;

const round = (value: number, digits = 2): number => {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
};

const roundRange = (range: TimeRange): [number, number] => [round(range.start), round(range.end)];

function capped<T>(items: ReadonlyArray<T>, limit: number): { shown: T[]; omitted: number } {
  return { shown: items.slice(0, limit), omitted: Math.max(0, items.length - limit) };
}

export interface MediaAnalysisSummary {
  assetId: string;
  durationSeconds: number;
  hasAudio: boolean;
  hasVideo: boolean;
  loudness: { peakDb: number; rmsDb: number; integratedApproxDb: number } | null;
  silences: Array<{ start: number; end: number; meanDb: number }>;
  silencesOmitted: number;
  speechLike: Array<[number, number]>;
  speechLikeOmitted: number;
  sceneCuts: number[];
  sceneCutsOmitted: number;
  shots: Array<{ start: number; end: number; motion: string }>;
  shotsOmitted: number;
  onsetCount: number;
  strongestOnsets: number[];
  tempoBpm?: number;
  tempoConfidence?: number;
  notes: string[];
}

/** Compact, rounded view of a MediaAnalysis: lists are capped and flagged with how many entries were left out. */
export function summarizeMediaAnalysis(analysis: MediaAnalysis): MediaAnalysisSummary {
  const silences = capped(analysis.silences, SUMMARY_LIMITS.silences);
  const speech = capped(analysis.speechLikeRanges, SUMMARY_LIMITS.speech);
  const cuts = capped(analysis.sceneCuts, SUMMARY_LIMITS.cuts);
  const shots = capped(analysis.shots, SUMMARY_LIMITS.shots);
  const strongest = [...analysis.onsets].sort((a, b) => b.strength - a.strength).slice(0, SUMMARY_LIMITS.onsets).map((o) => round(o.time)).sort((a, b) => a - b);
  return {
    assetId: analysis.assetId,
    durationSeconds: round(analysis.durationSeconds),
    hasAudio: analysis.hasAudio,
    hasVideo: analysis.hasVideo,
    loudness: analysis.loudness
      ? { peakDb: round(analysis.loudness.peakDb, 1), rmsDb: round(analysis.loudness.rmsDb, 1), integratedApproxDb: round(analysis.loudness.integratedApproxDb, 1) }
      : null,
    silences: silences.shown.map((s) => ({ start: round(s.start), end: round(s.end), meanDb: round(s.meanDb, 1) })),
    silencesOmitted: silences.omitted,
    speechLike: speech.shown.map(roundRange),
    speechLikeOmitted: speech.omitted,
    sceneCuts: cuts.shown.map((c) => round(c.time)),
    sceneCutsOmitted: cuts.omitted,
    shots: shots.shown.map((s) => ({ start: round(s.start), end: round(s.end), motion: s.motion })),
    shotsOmitted: shots.omitted,
    onsetCount: analysis.onsets.length,
    strongestOnsets: strongest,
    ...(analysis.tempoBpm !== undefined ? { tempoBpm: round(analysis.tempoBpm, 1) } : {}),
    ...(analysis.tempoConfidence !== undefined ? { tempoConfidence: round(analysis.tempoConfidence) } : {}),
    notes: analysis.notes,
  };
}

export function describeMediaAnalysis(summary: MediaAnalysisSummary): string {
  const parts = [`${summary.durationSeconds}s`];
  if (summary.hasAudio) parts.push(`${summary.silences.length + summary.silencesOmitted} silences`);
  if (summary.hasVideo) parts.push(`${summary.sceneCuts.length + summary.sceneCutsOmitted} scene cuts`);
  if (summary.loudness) parts.push(`integrated ~${summary.loudness.integratedApproxDb} dBFS`);
  if (summary.tempoBpm !== undefined) parts.push(`~${summary.tempoBpm} BPM`);
  return `Analyzed ${summary.assetId}: ${parts.join(", ")}.`;
}

export interface TimelineAnalysisSummary {
  durationSeconds: number;
  averageShotLengthSeconds: number;
  cutsPerMinute: number;
  pacingHistogram: Array<{ range: string; count: number }>;
  deadAir: { totalSeconds: number; ranges: Array<[number, number]>; omitted: number };
  overlappingClipPairs: number;
  tracks: Array<{ trackId: string; kind: string; clipCount: number; averageLengthSeconds: number; gapSeconds: number }>;
  tracksOmitted: number;
  loudness: {
    windowSeconds: number;
    db: number[];
    minDb: number;
    maxDb: number;
    /** Windows quieter than the loudest by more than 12 dB while audio is present, as [start, end]. */
    quietSpans: Array<[number, number]>;
  } | null;
}

/** Merges consecutive loudness windows into at most `maxWindows` longer windows (power-averaged in the dB domain via mean power). */
export function resampleLoudness(windows: ReadonlyArray<LoudnessWindow>, maxWindows: number): { windowSeconds: number; db: number[]; starts: number[] } {
  if (windows.length === 0) return { windowSeconds: 1, db: [], starts: [] };
  const first = windows[0] as LoudnessWindow;
  const baseSeconds = first.end - first.start;
  const group = Math.max(1, Math.ceil(windows.length / maxWindows));
  const db: number[] = [];
  const starts: number[] = [];
  for (let i = 0; i < windows.length; i += group) {
    const chunk = windows.slice(i, i + group);
    const power = chunk.reduce((sum, w) => sum + 10 ** (w.db / 10), 0) / chunk.length;
    db.push(round(10 * Math.log10(Math.max(power, 1e-10)), 1));
    starts.push((chunk[0] as LoudnessWindow).start);
  }
  return { windowSeconds: round(baseSeconds * group), db, starts };
}

export function summarizeTimelineAnalysis(input: { pacing: TimelineAnalysis; loudness: ReadonlyArray<LoudnessWindow> | null }): TimelineAnalysisSummary {
  const { pacing } = input;
  const deadAir = capped(pacing.deadAirRanges, SUMMARY_LIMITS.deadAir);
  const tracks = capped(pacing.tracks, SUMMARY_LIMITS.tracks);
  let loudness: TimelineAnalysisSummary["loudness"] = null;
  if (input.loudness && input.loudness.length > 0) {
    const resampled = resampleLoudness(input.loudness, SUMMARY_LIMITS.loudnessWindows);
    const audible = resampled.db.filter((v) => v > -90);
    const maxDb = audible.length ? Math.max(...audible) : -100;
    const quietSpans: Array<[number, number]> = [];
    resampled.db.forEach((value, index) => {
      if (audible.length && value < maxDb - 12) {
        const start = resampled.starts[index] as number;
        const last = quietSpans[quietSpans.length - 1];
        if (last && Math.abs(last[1] - start) < 1e-6) last[1] = round(start + resampled.windowSeconds);
        else quietSpans.push([round(start), round(start + resampled.windowSeconds)]);
      }
    });
    loudness = { windowSeconds: resampled.windowSeconds, db: resampled.db, minDb: audible.length ? Math.min(...audible) : -100, maxDb, quietSpans: quietSpans.slice(0, 10) };
  }
  return {
    durationSeconds: round(pacing.durationSeconds),
    averageShotLengthSeconds: round(pacing.averageShotLength),
    cutsPerMinute: round(pacing.cutsPerMinute, 1),
    pacingHistogram: pacing.pacingHistogram.map((b) => ({ range: b.maxSeconds === null ? `${b.minSeconds}s+` : `${b.minSeconds}-${b.maxSeconds}s`, count: b.count })),
    deadAir: { totalSeconds: round(pacing.deadAirSeconds), ranges: deadAir.shown.map(roundRange), omitted: deadAir.omitted },
    overlappingClipPairs: pacing.overlapCount,
    tracks: tracks.shown.map((t) => ({ trackId: t.trackId, kind: t.kind, clipCount: t.clipCount, averageLengthSeconds: round(t.averageLength), gapSeconds: round(t.gapSeconds) })),
    tracksOmitted: tracks.omitted,
    loudness,
  };
}

/** `count` evenly spaced sample times, each at the middle of an equal slice of [0, duration]. */
export function evenlySpacedTimes(input: { durationSeconds: number; count: number }): number[] {
  const count = Math.max(1, Math.min(SHEET_MAX_FRAMES, Math.floor(input.count)));
  const duration = Math.max(0, input.durationSeconds);
  return Array.from({ length: count }, (_, i) => round(((i + 0.5) / count) * duration, 3));
}

/** Cell size so a `columns`-wide grid of `frameCount` cells of the given aspect fits within `maxSide` on both sides. */
export function sheetCellSize(input: { canvas: { width: number; height: number }; columns: number; frameCount: number; maxSide?: number; gap?: number }): { width: number; height: number } {
  const maxSide = input.maxSide ?? SHEET_MAX_SIDE_PX;
  const gap = input.gap ?? SHEET_GAP_PX;
  const columns = Math.max(1, Math.min(Math.floor(input.columns), input.frameCount));
  const rows = Math.ceil(input.frameCount / columns);
  const maxWidth = (maxSide - (columns + 1) * gap) / columns;
  const maxHeight = (maxSide - (rows + 1) * gap) / rows;
  const scale = Math.min(maxWidth / input.canvas.width, maxHeight / input.canvas.height);
  return { width: Math.max(8, Math.floor(input.canvas.width * scale)), height: Math.max(8, Math.floor(input.canvas.height * scale)) };
}
