import { roundDb, roundMs } from "./measure";
import type { IndexShot, SilenceSpan, SpeechSegment, TemporalIndex } from "./types";

export const MAX_SHOT_LINES = 12;
export const MAX_SPEECH_LINES = 8;
export const MAX_SILENCE_LINES = 5;
export const MAX_TEXT_CHARS = 70;
/** About 700 tokens: the model should query for detail, not read a dump. */
export const MAX_DESCRIPTION_CHARS = 3000;

export const CORE_TRACKS: ReadonlySet<string> = new Set(["speech", "speechLike", "silence", "onset"]);

const secs = (value: number): string => `${roundMs(value)}s`;
const db = (value: number | null): string => (value === null ? "n/a" : `${roundDb(value)}dB`);
const clip = (text: string): string => (text.length > MAX_TEXT_CHARS ? `${text.slice(0, MAX_TEXT_CHARS - 1)}...` : text);
const more = (shown: number, total: number, what: string): string[] => (total > shown ? [`  ... ${total - shown} more ${what} (use find_moments)`] : []);

function shotLine(shot: IndexShot): string {
  const parts = [`mean ${db(shot.loudnessMeanDb)}`, `peak ${db(shot.loudnessPeakDb)}`];
  if (shot.silenceRatio !== null) parts.push(`silent ${Math.round(shot.silenceRatio * 100)}%`);
  parts.push(`${shot.speechWordCount} words (${roundMs(shot.wordsPerSecond)}/s)`);
  if (shot.motion) parts.push(`motion ${shot.motion}`);
  return `  #${shot.index} ${secs(shot.startSeconds)}-${secs(shot.endSeconds)}: ${parts.join(", ")}`;
}

const speechLine = (s: SpeechSegment): string => `  [${s.startWord}-${s.endWord}] ${secs(s.startSeconds)}-${secs(s.endSeconds)} (shot ${s.shotIndex}) "${clip(s.text)}"`;

function silenceLines(silences: ReadonlyArray<SilenceSpan>): string[] {
  const longest = [...silences].sort((a, b) => (b.endSeconds - b.startSeconds) - (a.endSeconds - a.startSeconds) || a.startSeconds - b.startSeconds).slice(0, MAX_SILENCE_LINES);
  longest.sort((a, b) => a.startSeconds - b.startSeconds);
  return [
    ...longest.map((s) => `  ${secs(s.startSeconds)}-${secs(s.endSeconds)} (${db(s.meanDb)})`),
    ...more(longest.length, silences.length, "silences"),
  ];
}

/** Compact, size-bounded English for the model: structure and numbers, with pointers to find_moments for detail. */
export function describeIndex(index: TemporalIndex): string {
  const { shots, tracks, rhythm, sources } = index;
  const known = [sources.analysis ? "analysis" : null, sources.transcript ? "transcript" : null].filter((x): x is string => x !== null);
  const lines = [`Footage ${index.assetId}: ${secs(index.durationSeconds)}, ${shots.length} shot(s). Indexed from: ${known.join(" + ") || "nothing"}. Times are SOURCE seconds.`];
  if (!sources.analysis) lines.push("No audio/video analysis: loudness, silence and shot data are missing (run analyze_media).");
  if (!sources.transcript) lines.push("No transcript: speech and phrase search are unavailable (run transcribe_asset).");

  lines.push("Shots:", ...shots.slice(0, MAX_SHOT_LINES).map(shotLine), ...more(MAX_SHOT_LINES, shots.length, "shots"));

  if (tracks.speech.length > 0) {
    const spoken = tracks.speech.reduce((sum, s) => sum + (s.endSeconds - s.startSeconds), 0);
    lines.push(`Speech: ${tracks.speech.length} sentence(s), ${index.words.length} words, ${Math.round((spoken / Math.max(index.durationSeconds, 1e-9)) * 100)}% of the time.`);
    lines.push(...tracks.speech.slice(0, MAX_SPEECH_LINES).map(speechLine), ...more(MAX_SPEECH_LINES, tracks.speech.length, "sentences"));
  }
  if (tracks.silence.length > 0) {
    const total = tracks.silence.reduce((sum, s) => sum + (s.endSeconds - s.startSeconds), 0);
    lines.push(`Silences: ${tracks.silence.length}, ${secs(total)} in total. Longest:`, ...silenceLines(tracks.silence));
  }
  if (rhythm) {
    const grid = rhythm.beatGrid;
    lines.push(`Rhythm: ${rhythm.onsetCount} onsets${grid ? `, ${Math.round(grid.bpm)} bpm (confidence ${roundMs(grid.confidence)}), first beat ${secs(grid.firstBeatSeconds)}` : ", no steady tempo"}.`);
  }
  const extra = Object.entries(tracks).filter(([kind]) => !CORE_TRACKS.has(kind) && (tracks[kind]?.length ?? 0) > 0);
  if (extra.length > 0) lines.push(`Other tracks: ${extra.map(([kind, events]) => `${kind} (${events.length})`).join(", ")}.`);

  const text = lines.join("\n");
  return text.length > MAX_DESCRIPTION_CHARS ? `${text.slice(0, MAX_DESCRIPTION_CHARS - 20)}\n... (truncated)` : text;
}

const SUMMARY_LIMIT = 50;

/** Structured counterpart of `describeIndex` for tool results; every list is capped. */
export function summarizeIndex(index: TemporalIndex): Record<string, unknown> {
  const capped = <T>(items: ReadonlyArray<T>): { items: T[]; total: number } => ({ items: items.slice(0, SUMMARY_LIMIT), total: items.length });
  const round = (n: number | null): number | null => (n === null ? null : roundDb(n));
  return {
    assetId: index.assetId,
    durationSeconds: roundMs(index.durationSeconds),
    sources: index.sources,
    shots: capped(index.shots.map((s) => ({
      index: s.index, startSeconds: roundMs(s.startSeconds), endSeconds: roundMs(s.endSeconds), loudnessMeanDb: round(s.loudnessMeanDb), loudnessPeakDb: round(s.loudnessPeakDb),
      silenceRatio: s.silenceRatio === null ? null : roundMs(s.silenceRatio), speechWordCount: s.speechWordCount, wordsPerSecond: roundMs(s.wordsPerSecond),
    }))),
    speech: capped(index.tracks.speech.map((s) => ({ startWord: s.startWord, endWord: s.endWord, startSeconds: roundMs(s.startSeconds), endSeconds: roundMs(s.endSeconds), shotIndex: s.shotIndex, text: clip(s.text) }))),
    silences: capped(index.tracks.silence.map((s) => ({ startSeconds: roundMs(s.startSeconds), endSeconds: roundMs(s.endSeconds), meanDb: roundDb(s.meanDb) }))),
    rhythm: index.rhythm,
    otherTracks: Object.fromEntries(Object.entries(index.tracks).filter(([kind]) => !CORE_TRACKS.has(kind)).map(([kind, events]) => [kind, events.length])),
  };
}
