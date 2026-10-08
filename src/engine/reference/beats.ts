import type { MediaAnalysis, TimelineTrackInput } from "#/engine/analysis";

const MIN_TEMPO_CONFIDENCE = 0.2;
const MIN_ONSET_STRENGTH = 0.3;
const MAX_BEATS = 100_000;

/**
 * Beat times (seconds) for one source. With a confident tempo this is a regular grid whose phase is the
 * strength-weighted circular mean of the onsets; otherwise the strong onsets themselves.
 */
export function beatTimes(analysis: MediaAnalysis): number[] {
  const bpm = analysis.tempoBpm;
  const confident = bpm !== undefined && bpm > 0 && (analysis.tempoConfidence ?? 0) >= MIN_TEMPO_CONFIDENCE;
  if (!confident) {
    return analysis.onsets.filter((o) => o.strength >= MIN_ONSET_STRENGTH).map((o) => o.time).sort((a, b) => a - b);
  }
  const period = 60 / bpm;
  let sin = 0;
  let cos = 0;
  for (const onset of analysis.onsets) {
    const angle = (2 * Math.PI * onset.time) / period;
    sin += onset.strength * Math.sin(angle);
    cos += onset.strength * Math.cos(angle);
  }
  const phase = analysis.onsets.length === 0 ? 0 : (((Math.atan2(sin, cos) / (2 * Math.PI)) * period) % period + period) % period;
  const beats: number[] = [];
  for (let t = phase; t <= analysis.durationSeconds && beats.length < MAX_BEATS; t += period) beats.push(t);
  return beats;
}

/** Share of `cuts` within `tolerance` seconds of some beat. Both arrays must be ascending. */
export function beatLockScore(input: { cuts: ReadonlyArray<number>; beats: ReadonlyArray<number>; tolerance: number }): { hits: number; total: number } {
  const { cuts, beats, tolerance } = input;
  let hits = 0;
  let cursor = 0;
  for (const cut of cuts) {
    while (cursor + 1 < beats.length && (beats[cursor + 1] as number) <= cut) cursor++;
    const before = beats[cursor];
    const after = beats[cursor + 1];
    const nearest = Math.min(
      before === undefined ? Infinity : Math.abs(cut - before),
      after === undefined ? Infinity : Math.abs(after - cut),
    );
    if (nearest <= tolerance + 1e-9) hits++;
  }
  return { hits, total: cuts.length };
}

/** Beats on the timeline: each audio clip's source beats mapped through its start, trim and rate. */
export function timelineBeats(input: { tracks: ReadonlyArray<TimelineTrackInput>; analyses: ReadonlyMap<string, MediaAnalysis> }): number[] {
  const out: number[] = [];
  for (const track of input.tracks) {
    if (track.kind !== "audio") continue;
    for (const clip of track.clips) {
      const analysis = clip.mediaId === undefined ? undefined : input.analyses.get(clip.mediaId);
      if (!analysis) continue;
      const trim = clip.trimStart ?? 0;
      const rate = clip.rate ?? 1;
      const sourceEnd = trim + (clip.end - clip.start) * rate;
      for (const beat of beatTimes(analysis)) {
        if (beat >= trim && beat < sourceEnd) out.push(clip.start + (beat - trim) / rate);
      }
    }
  }
  return out.sort((a, b) => a - b);
}
