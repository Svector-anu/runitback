import { beatLockScore } from "#/engine/reference";
import type { AnalysisProvider } from "#/engine/reference";
import {
  BEAT_SNAP_DEFAULT_TOLERANCE_SECONDS, BEAT_SNAP_MAX_TOLERANCE_SECONDS, planBeatSnap, snapCutsToBeatCommand, timelineBeatsFor,
} from "#/engine/beatsync";
import { TICKS_PER_SECOND } from "#/engine/time";
import { defineTool, ok, toSec, ToolError } from "./env";
import type { AgentTool } from "./types";

const LOCK_TOLERANCE_SECONDS = 0.06;
const MAX_REPORTED_MOVES = 30;
const sec = (ticks: number): number => ticks / TICKS_PER_SECOND;

export function createBeatTools(deps: { provider: AnalysisProvider }): AgentTool[] {
  const snap = defineTool<{ elementIds?: string[]; toleranceSeconds?: number; dryRun?: boolean }>({
    name: "snap_cuts_to_beat",
    description:
      `Moves the cuts of the video tracks (the shared edge of two touching clips) onto the nearest beat of the music on the audio tracks, within toleranceSeconds (default ${BEAT_SNAP_DEFAULT_TOLERANCE_SECONDS}, max ${BEAT_SNAP_MAX_TOLERANCE_SECONDS}). Each move is a rolling edit: the left clip's end and the right clip's start move together, so total length, other clips and the source mapping are preserved; a cut is skipped when a clip has no spare media to grow into or would become shorter than a frame. Pass elementIds to snap only the cuts next to those clips. Beats come from the audio analysis of the unmuted audio-track clips (analyzed on demand, cached); with no confident tempo the strong onsets are used. dryRun:true reports without editing. One undo step. Reports how many cuts sit within 60 ms of a beat before and after.`,
    inputSchema: {
      type: "object",
      properties: {
        elementIds: { type: "array", items: { type: "string" }, description: "Clip ids from get_timeline; only cuts next to them are snapped. Omit for the whole timeline." },
        toleranceSeconds: { type: "number", minimum: 0.01, maximum: BEAT_SNAP_MAX_TOLERANCE_SECONDS, description: "Largest distance a cut may move, in SECONDS." },
        dryRun: { type: "boolean" },
      },
    },
    readOnly: false,
    async run(input, env) {
      env.requireProject();
      if (input.elementIds) env.requireMany(input.elementIds);
      const beats = await timelineBeatsFor({ tracks: env.tracks, provider: deps.provider });
      if (beats.length === 0) {
        throw new ToolError("There are no beats to snap to.", "Put music on an unmuted audio track; if it is already there the track may have no detectable rhythm.");
      }
      const plan = planBeatSnap({
        tracks: env.tracks, beatsSeconds: beats, fps: env.fps,
        toleranceSeconds: input.toleranceSeconds ?? BEAT_SNAP_DEFAULT_TOLERANCE_SECONDS,
        ...(input.elementIds ? { elementIds: input.elementIds } : {}),
      });
      if (plan.cutCount === 0) throw new ToolError("No cuts to snap: there are no touching clips on a video track" + (input.elementIds ? " next to those clips." : "."));
      const cuts = plan.moves.map((m) => sec(m.fromTicks)).concat(plan.skipped.map((s) => sec(s.atTicks))).sort((a, b) => a - b);
      const after = plan.moves.map((m) => sec(m.toTicks)).concat(plan.skipped.map((s) => sec(s.atTicks))).sort((a, b) => a - b);
      const lockBefore = beatLockScore({ cuts, beats, tolerance: LOCK_TOLERANCE_SECONDS });
      const lockAfter = beatLockScore({ cuts: after, beats, tolerance: LOCK_TOLERANCE_SECONDS });
      const skipped: Record<string, number> = {};
      for (const s of plan.skipped) skipped[s.reason] = (skipped[s.reason] ?? 0) + 1;
      const data = {
        cuts: plan.cutCount, moved: plan.moves.length, skipped, dryRun: input.dryRun === true,
        onBeatBefore: lockBefore.hits, onBeatAfter: lockAfter.hits, lockToleranceSeconds: LOCK_TOLERANCE_SECONDS,
        moves: plan.moves.slice(0, MAX_REPORTED_MOVES).map((m) => ({ leftId: m.leftId, rightId: m.rightId, from: toSec(m.fromTicks), to: toSec(m.toTicks) })),
        movesOmitted: Math.max(0, plan.moves.length - MAX_REPORTED_MOVES),
      };
      const verb = input.dryRun ? "Would move" : "Moved";
      const summary = `${verb} ${plan.moves.length} of ${plan.cutCount} cuts onto the beat; cuts within 60 ms of a beat: ${lockBefore.hits} -> ${lockAfter.hits} of ${lockAfter.total}.`;
      if (input.dryRun || plan.moves.length === 0) return ok(plan.moves.length === 0 ? `No cut needed to move (${plan.cutCount} checked). ${summary}` : summary, data);
      env.editor.execute(snapCutsToBeatCommand(plan));
      return ok(summary, data);
    },
  });
  return [snap];
}
