import type { Project } from "#/engine/model";
import { clipsOf, FRAME_SECONDS } from "./timeline";
import type { Check, CheckInput, CheckResult } from "./types";

const EPSILON = 1e-6;
export const clamp01 = (value: number): number => Math.max(0, Math.min(1, value));

export const pass = (detail: string): CheckResult => ({ pass: true, score: 1, detail });
export const fail = (detail: string): CheckResult => ({ pass: false, score: 0, detail });
export const verdict = (ok: boolean, detail: string): CheckResult => (ok ? pass(detail) : fail(detail));

/** Partial credit: passes at `score >= threshold`. */
export function graded(input: { score: number; threshold: number; detail: string }): CheckResult {
  const score = clamp01(input.score);
  return { pass: score >= input.threshold - EPSILON, score, detail: input.detail };
}

/** The part of a project that is the document: scenes, settings and the current scene. View state and timestamps are excluded. */
export function documentKey(project: Project): string {
  return JSON.stringify({ scenes: project.scenes, currentSceneId: project.currentSceneId, settings: project.settings });
}

function visitNumbers(value: unknown, path: string, visit: (path: string, n: number) => void): void {
  if (typeof value === "number") visit(path, value);
  else if (Array.isArray(value)) value.forEach((item, i) => visitNumbers(item, `${path}[${i}]`, visit));
  else if (value !== null && typeof value === "object") for (const [key, inner] of Object.entries(value)) visitNumbers(inner, `${path}.${key}`, visit);
}

const noOverlaps: Check = {
  id: "no-overlaps",
  description: "No two elements on one track overlap (touching edges are fine).",
  invariant: true,
  run({ final }) {
    const clips = clipsOf(final);
    const byTrack = new Map<string, typeof clips>();
    for (const clip of clips) byTrack.set(clip.trackId, [...(byTrack.get(clip.trackId) ?? []), clip]);
    for (const [trackId, list] of byTrack) {
      const sorted = [...list].sort((a, b) => a.start - b.start);
      for (let i = 1; i < sorted.length; i++) {
        const prev = sorted[i - 1];
        const next = sorted[i];
        if (prev && next && next.start < prev.end - EPSILON) return fail(`${prev.id} (to ${prev.end.toFixed(3)}s) overlaps ${next.id} (from ${next.start.toFixed(3)}s) on track ${trackId}`);
      }
    }
    return pass(`${clips.length} elements, no overlaps`);
  },
};

const finiteValues: Check = {
  id: "finite-values",
  description: "Every number in the timeline and settings is finite (no NaN or Infinity).",
  invariant: true,
  run({ final }) {
    const bad: string[] = [];
    visitNumbers({ scenes: final.scenes, settings: final.settings }, "project", (path, n) => {
      if (!Number.isFinite(n)) bad.push(path);
    });
    return verdict(bad.length === 0, bad.length === 0 ? "all numbers finite" : `non-finite values at ${bad.slice(0, 3).join(", ")}`);
  },
};

const nonNegativeTimes: Check = {
  id: "non-negative-times",
  description: "Start times and trims are >= 0 and every duration is > 0.",
  invariant: true,
  run({ final }) {
    for (const clip of clipsOf(final)) {
      if (clip.start < -EPSILON) return fail(`${clip.id} starts at ${clip.start}s`);
      if (clip.duration <= 0) return fail(`${clip.id} has duration ${clip.duration}s`);
      if (clip.trimStart < -EPSILON || clip.trimEnd < -EPSILON) return fail(`${clip.id} has a negative trim (${clip.trimStart}s / ${clip.trimEnd}s)`);
    }
    return pass("all times valid");
  },
};

const sourceMapping: Check = {
  id: "source-mapping",
  description: "For media clips, trimStart + duration * rate + trimEnd equals the source duration (within one frame).",
  invariant: true,
  run({ final }) {
    for (const clip of clipsOf(final)) {
      if (clip.sourceDuration === undefined || clip.mediaId === undefined) continue;
      const total = clip.trimStart + clip.duration * clip.rate + clip.trimEnd;
      if (Math.abs(total - clip.sourceDuration) > FRAME_SECONDS) {
        return fail(`${clip.id}: trims + played span = ${total.toFixed(3)}s but the source is ${clip.sourceDuration.toFixed(3)}s`);
      }
    }
    return pass("source mapping holds");
  },
};

const undoRestores: Check = {
  id: "undo-restores-original",
  description: "A single undo returns the document to exactly what it was before the run.",
  invariant: true,
  run({ initial, afterUndo }) {
    return verdict(documentKey(initial) === documentKey(afterUndo), documentKey(initial) === documentKey(afterUndo) ? "one undo restored the original" : "document after one undo differs from the original");
  },
};

const agentFinished: Check = {
  id: "agent-finished",
  description: "The run ended with the model's own final answer (not an error, step limit or token budget).",
  invariant: true,
  run({ run }) {
    return verdict(run.status === "done", run.status === "done" ? "finished" : `run ended with status "${run.status}"${run.error ? `: ${run.error}` : ""}`);
  },
};

export const INVARIANT_CHECKS: ReadonlyArray<Check> = [agentFinished, noOverlaps, finiteValues, nonNegativeTimes, sourceMapping, undoRestores];

export function runCheck(check: Check, input: CheckInput): CheckResult {
  try {
    const result = check.run(input);
    return { ...result, score: clamp01(result.score) };
  } catch (error) {
    return fail(`check crashed: ${error instanceof Error ? error.message : String(error)}`);
  }
}
