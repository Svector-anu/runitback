import { expect } from "vitest";
import { callTool, createAgentTools, createTemporalTools, type AgentToolRegistry, type ToolResult } from "#/engine/agent";
import { LEVEL_CURVE_WINDOW_SECONDS, MEDIA_ANALYSIS_VERSION, type MediaAnalysis } from "#/engine/analysis";
import type { Editor } from "#/engine/editor";
import type { MediaAssetInfo } from "#/engine/model";
import { createMapAnalysisProvider } from "#/engine/reference";
import { buildTemporalIndex } from "#/engine/temporal";
import { createMemoryTranscriptStore, TRANSCRIPT_VERSION, type Transcript, type TranscriptWord } from "#/engine/transcript";
import { ASSETS } from "./agent-harness";
import { makeEditor } from "./helpers";

/** Words spread evenly over [start, end] with a short gap after each, so every sentence has exact timings. */
export function spoken(text: string, start: number, end: number): TranscriptWord[] {
  const tokens = text.split(" ");
  const slot = (end - start) / tokens.length;
  return tokens.map((token, i) => ({ text: token, startSeconds: start + i * slot, endSeconds: start + (i + 1) * slot - 0.04 }));
}

export const transcriptOf = (assetId: string, words: TranscriptWord[]): Transcript => ({ version: TRANSCRIPT_VERSION, assetId, language: "en", model: "test", words });

/**
 * Asset a1 (10 s), three shots with distinct loudness:
 *   shot 0 [0,3)  -30 dB, "Welcome to the show."
 *   shot 1 [3,7)  -10 dB with a silence at [4.5,5.5), "Let us talk about the budget." and "The budget is tight."
 *   shot 2 [7,10) -20 dB, "Thanks for watching."
 */
export const SHOT_CUTS = [3, 7] as const;
export const SILENCE = { start: 4.5, end: 5.5 } as const;
export const SHOT_LEVELS_DB = [-30, -10, -20] as const;

export const TALK_WORDS: TranscriptWord[] = [
  ...spoken("Welcome to the show.", 0.2, 2.4),
  ...spoken("Let us talk about the budget.", 3.2, 4.4),
  ...spoken("The budget is tight.", 5.6, 6.8),
  ...spoken("Thanks for watching.", 7.4, 9.5),
];

export interface AnalysisOptions {
  assetId?: string;
  duration?: number;
  cuts?: number[];
  levels?: number[];
  silences?: Array<{ start: number; end: number }>;
  tempo?: { bpm: number; confidence: number };
  hasAudio?: boolean;
}

export function makeAnalysis(options: AnalysisOptions = {}): MediaAnalysis {
  const duration = options.duration ?? 10;
  const cuts = options.cuts ?? [...SHOT_CUTS];
  const sortedCuts = [...cuts].sort((a, b) => a - b);
  const silences = options.silences ?? [SILENCE];
  const bounds = [0, ...sortedCuts, duration];
  const levelOf = (t: number): number => {
    if (silences.some((s) => t >= s.start && t < s.end)) return -90;
    const shot = bounds.findIndex((b, i) => t >= b && t < (bounds[i + 1] ?? Infinity));
    const levels = options.levels ?? [...SHOT_LEVELS_DB];
    return levels[Math.min(shot, levels.length - 1)] ?? -20;
  };
  const windows = Math.ceil(duration / LEVEL_CURVE_WINDOW_SECONDS);
  const hasAudio = options.hasAudio ?? true;
  return {
    assetId: options.assetId ?? "a1",
    version: MEDIA_ANALYSIS_VERSION,
    durationSeconds: duration,
    hasAudio,
    hasVideo: true,
    silences: hasAudio ? silences.map((s) => ({ ...s, meanDb: -90 })) : [],
    loudness: hasAudio ? { peakDb: -5, rmsDb: -18, integratedApproxDb: -16 } : null,
    speechLikeRanges: [],
    onsets: [{ time: 0.5, strength: 0.4 }, { time: 1, strength: 0.9 }, { time: 1.5, strength: 0.8 }, { time: 2, strength: 0.7 }],
    ...(options.tempo ? { tempoBpm: options.tempo.bpm, tempoConfidence: options.tempo.confidence } : {}),
    levelCurve: hasAudio ? { windowSeconds: LEVEL_CURVE_WINDOW_SECONDS, db: Array.from({ length: windows }, (_, i) => levelOf(i * LEVEL_CURVE_WINDOW_SECONDS + 1e-6)) } : null,
    sceneCuts: cuts.map((time) => ({ time, score: 0.9 })),
    shots: bounds.slice(0, -1).map((start, i) => ({ start, end: bounds[i + 1] as number, motion: i === 1 ? "high" as const : "low" as const, motionScore: 0.1, dominantColors: [] })),
    notes: [],
  };
}

export function standardIndex(assetId = "a1") {
  return buildTemporalIndex({ assetId, duration: 10, analysis: makeAnalysis({ assetId, tempo: { bpm: 120, confidence: 0.9 } }), transcript: transcriptOf(assetId, TALK_WORDS) });
}

export interface TemporalHarness {
  editor: Editor;
  tools: AgentToolRegistry;
  store: ReturnType<typeof createMemoryTranscriptStore>;
  call(name: string, args?: unknown): Promise<ToolResult>;
  data<T = Record<string, unknown>>(name: string, args?: unknown): Promise<T>;
  failure(name: string, args?: unknown): Promise<{ error: string; hint: string }>;
}

export function setupTemporal(options: { assets?: MediaAssetInfo[]; analyses?: MediaAnalysis[]; transcripts?: Transcript[] } = {}): TemporalHarness {
  const { editor } = makeEditor({ assets: options.assets ?? ASSETS });
  const store = createMemoryTranscriptStore();
  for (const t of options.transcripts ?? [transcriptOf("a1", TALK_WORDS)]) store.save(t);
  const provider = createMapAnalysisProvider(options.analyses ?? [makeAnalysis({ tempo: { bpm: 120, confidence: 0.9 } })]);
  const tools = new Map(createAgentTools());
  for (const tool of createTemporalTools({ analysis: provider, transcripts: store })) tools.set(tool.name, tool);
  const ctx = { editor, nowMs: () => 0 };
  const call = (name: string, args: unknown = {}): Promise<ToolResult> => callTool({ tools, name, args, ctx });
  return {
    editor, tools, store, call,
    async data<T>(name: string, args?: unknown): Promise<T> {
      const result = await call(name, args);
      if (!result.ok) throw new Error(`${name} failed: ${result.error} (${result.hint ?? "no hint"})`);
      return result.data as T;
    },
    async failure(name: string, args?: unknown) {
      const result = await call(name, args);
      expect(result.ok, `${name} should fail`).toBe(false);
      if (result.ok) throw new Error("unreachable");
      return { error: result.error, hint: result.hint ?? "" };
    },
  };
}
