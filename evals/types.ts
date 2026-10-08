import type { Project } from "#/engine/model";
import type { TranscriptWord } from "#/engine/transcript";
import type { AgentStatus } from "#/app/agent/loop";
import type { TokenUsage } from "#/app/agent/model-client";

export interface Range {
  start: number;
  end: number;
}

export interface ColorBlock {
  seconds: number;
  rgb: [number, number, number];
}

/** What the soundtrack of a fixture contains. Everything is declared, so ground truth is exact by construction. */
export type AudioSpec =
  | { kind: "none" }
  /** A steady tone for the whole duration (no silences). */
  | { kind: "tone" }
  /** Tone only inside `speech`; everything else is digital silence. */
  | { kind: "speech"; speech: Range[] }
  /** Quiet pad plus a loud click on every beat `phase + k * 60 / bpm`. */
  | { kind: "beat"; bpm: number; phase: number };

/** Declarative synthetic media: the structure of a clip, never its bytes. */
export interface FixtureSpec {
  id: string;
  /** File name shown to the agent (list_assets). Briefs refer to fixtures by this name. */
  name: string;
  kind: "video" | "audio";
  durationSeconds: number;
  audio: AudioSpec;
  /** Colour structure of a video fixture; one grey block when omitted. Block edges are the scene cuts. */
  blocks?: ColorBlock[];
  /**
   * Initial timeline placement in seconds: videos go on the main track, audio on the first audio track, in
   * declaration order. Omit to leave the fixture in the media pool only.
   */
  placeAt?: number;
  /** Words spoken in the fixture, in SOURCE seconds. When present the case gets the transcript tools backed by a store holding it. */
  transcript?: TranscriptWord[];
}

/** Exact facts about a fixture, derived from its spec (or from a real measurement, see fixtures.ts). All times in seconds of the fixture's own source. */
export interface FixtureTruth {
  durationSeconds: number;
  hasAudio: boolean;
  /** Ranges where sound is present (speech tone, music, steady tone). */
  sound: Range[];
  /** Complement of `sound` inside [0, duration]. */
  silences: Range[];
  /** Beat times, empty when the fixture has no beat grid. */
  beats: number[];
  /** Contiguous shots, empty for audio fixtures. */
  shots: Range[];
}

export interface ResolvedFixture {
  spec: FixtureSpec;
  /** Asset id in the project under test (equal to `spec.id` for headless runs). */
  assetId: string;
  truth: FixtureTruth;
}

export interface RunSummary {
  status: AgentStatus;
  finalText: string;
  steps: number;
  changed: boolean;
  usage: TokenUsage;
  error?: string;
}

export interface CheckInput {
  /** The project before the agent ran. */
  initial: Project;
  /** The project right after the run. */
  final: Project;
  /** The project after one undo of the run; equals `final` when the run changed nothing. */
  afterUndo: Project;
  fixtures: ResolvedFixture[];
  run: RunSummary;
}

export interface CheckResult {
  pass: boolean;
  /** 0..1: partial credit for graded checks, 0 or 1 for binary ones. */
  score: number;
  detail: string;
}

/** A pure function over the final project and the fixture ground truth. */
export interface Check {
  id: string;
  description: string;
  /** Invariant checks are appended to every case and describe a healthy project, not task success. */
  invariant?: boolean;
  run(input: CheckInput): CheckResult;
}

export interface EvalBudget {
  maxSteps: number;
  maxTokens: number;
}

export interface EvalCase {
  id: string;
  title: string;
  /** The user's request, verbatim. */
  brief: string;
  fixtures: FixtureSpec[];
  budget: EvalBudget;
  /** Task checks; the invariant checks are added by the harness. */
  checks: Check[];
  /** Set when no oracle can solve the case with today's tools: the reason, and what is missing. */
  blocked?: string;
}

export interface CheckOutcome extends CheckResult {
  id: string;
  invariant: boolean;
}

export interface CaseResult {
  caseId: string;
  policyId: string;
  run: RunSummary;
  outcomes: CheckOutcome[];
  /** Mean check score, 0..1. */
  score: number;
  /** True when every check passed. */
  passed: boolean;
  toolCalls: string[];
}
