import { batch, setTransitionCommand, type Command } from "#/engine/commands";
import { TRANSITION_TYPES, type TransitionType } from "#/engine/model";
import {
  canHaveTransition, effectiveTransition, elementEnd, maxTransitionDuration, transitionPartner, TRANSITION_NAMES, type LocatedElement,
} from "#/engine/timeline";
import { mediaTimeFromSeconds, roundToFrame } from "#/engine/time";
import { defineTool, ok, toSec, ToolError, type ToolEnv } from "./env";
import type { AgentTool } from "./types";

const DEFAULT_TRANSITION_SECONDS = 0.5;
const TYPE_LIST = TRANSITION_TYPES.map((t) => `${t} (${TRANSITION_NAMES[t]})`).join(", ");

function siblingsOf(env: ToolEnv, located: LocatedElement) {
  const track = env.requireTrack(located.track.id);
  return track.elements as Parameters<typeof transitionPartner>[0];
}

/** Resolves the requested length in ticks, snapped to frames, and rejects what cannot fit. */
function plan(env: ToolEnv, incoming: LocatedElement, seconds: number | undefined): { ticks: number; clamped: boolean; max: number } {
  const element = incoming.element;
  if (!canHaveTransition(element)) {
    throw new ToolError(`A ${element.type} clip cannot have a transition.`, "Transitions apply between two video or image clips on the same track.");
  }
  const partner = transitionPartner(siblingsOf(env, incoming), element);
  if (!partner) {
    throw new ToolError(
      `"${element.id}" has no clip ending exactly where it starts (${toSec(element.startTime)}s) on its track.`,
      "Transitions need two touching clips on one track. Move the clips together first (move / trim), then retry.",
    );
  }
  const max = maxTransitionDuration(partner, element);
  const wanted = roundToFrame(mediaTimeFromSeconds(seconds ?? DEFAULT_TRANSITION_SECONDS), env.fps);
  const ticks = Math.min(Math.max(wanted, 1), max);
  if (ticks < 1) throw new ToolError("The two clips are too short for a transition.", "Each clip needs at least a couple of frames.");
  return { ticks, clamped: ticks < wanted, max };
}

const INPUT_PROPS = {
  type: { type: "string", enum: [...TRANSITION_TYPES], description: `One of: ${TYPE_LIST}.` },
  duration: { type: "number", minimum: 0.04, description: `Length in SECONDS (default ${DEFAULT_TRANSITION_SECONDS}); clamped to half of the shorter clip. Centred on the cut.` },
} as const;

const setTransition = defineTool<{ elementIds: string[]; type: TransitionType; duration?: number }>({
  name: "set_transition",
  description:
    "Set the transition INTO each given clip (the incoming clip) from the clip that ends exactly where it starts on the same track. Replaces an existing transition. Clip positions and lengths never change: the blend is centred on the cut and uses the source media around it. Fails (nothing changes) if any clip has no touching predecessor. All clips change as one undo step. `duration` is in SECONDS.",
  inputSchema: {
    type: "object",
    properties: { elementIds: { type: "array", items: { type: "string" }, description: "Incoming clip ids from get_timeline." }, ...INPUT_PROPS },
    required: ["elementIds", "type"],
  },
  readOnly: false,
  run(input, env) {
    env.requireProject();
    if (input.elementIds.length === 0) throw new ToolError("elementIds is empty.", "Pass at least one clip id.");
    const targets = env.requireMany(input.elementIds);
    const planned = targets.map((l) => ({ located: l, ...plan(env, l, input.duration) }));
    const commands: Command[] = planned.map((p) => setTransitionCommand({ ref: p.located.ref, transition: { type: input.type, duration: p.ticks } }));
    env.editor.execute(batch("Set transition", commands));
    const applied = planned.map((p) => {
      const t = effectiveTransition(siblingsOf(env, env.require(p.located.element.id)), env.require(p.located.element.id).element);
      return { elementId: p.located.element.id, type: input.type, duration: t ? toSec(t.duration) : 0, clamped: p.clamped, maxDuration: toSec(p.max) };
    });
    return ok(`Set ${input.type} transition on ${applied.length} clip(s).`, { transitions: applied });
  },
});

const addTransition = defineTool<{ fromElementId: string; toElementId: string; type: TransitionType; duration?: number }>({
  name: "add_transition",
  description:
    "Add a transition between two adjacent clips: `fromElementId` is the clip that plays first, `toElementId` the one that follows and must start exactly where the first ends (same track). `duration` is in SECONDS. Same semantics as set_transition on the second clip, but verifies the pair so a wrong order or a gap is reported instead of guessed.",
  inputSchema: {
    type: "object",
    properties: { fromElementId: { type: "string" }, toElementId: { type: "string" }, ...INPUT_PROPS },
    required: ["fromElementId", "toElementId", "type"],
  },
  readOnly: false,
  run(input, env) {
    env.requireProject();
    const from = env.require(input.fromElementId);
    const to = env.require(input.toElementId);
    if (from.track.id !== to.track.id || elementEnd(from.element) !== to.element.startTime) {
      throw new ToolError(
        `"${from.element.id}" (${toSec(from.element.startTime)}s-${toSec(elementEnd(from.element))}s) does not end where "${to.element.id}" starts (${toSec(to.element.startTime)}s) on the same track.`,
        "Pass the earlier clip as fromElementId and the clip immediately after it as toElementId; close any gap first.",
      );
    }
    const p = plan(env, to, input.duration);
    env.editor.execute(setTransitionCommand({ ref: to.ref, transition: { type: input.type, duration: p.ticks } }));
    return ok(`Added ${input.type} transition between ${from.element.id} and ${to.element.id} (${toSec(p.ticks)}s).`, {
      elementId: to.element.id, type: input.type, duration: toSec(p.ticks), clamped: p.clamped, maxDuration: toSec(p.max),
    });
  },
});

const removeTransition = defineTool<{ elementIds: string[] }>({
  name: "remove_transition",
  description: "Remove the transition into each given clip (the incoming clip). Clips without one are skipped and reported.",
  inputSchema: { type: "object", properties: { elementIds: { type: "array", items: { type: "string" } } }, required: ["elementIds"] },
  readOnly: false,
  run(input, env) {
    env.requireProject();
    const targets = env.requireMany(input.elementIds);
    const withOne = targets.filter((l) => canHaveTransition(l.element) && l.element.transition);
    if (withOne.length === 0) throw new ToolError("None of those clips has a transition.", "Use get_element to see a clip's transition.");
    env.editor.execute(batch("Remove transition", withOne.map((l) => setTransitionCommand({ ref: l.ref, transition: null }))));
    const skipped = targets.filter((l) => !withOne.includes(l)).map((l) => l.element.id);
    return ok(`Removed ${withOne.length} transition(s).`, { removed: withOne.map((l) => l.element.id), skipped });
  },
});

export const TRANSITION_TOOLS: AgentTool[] = [setTransition, addTransition, removeTransition];
