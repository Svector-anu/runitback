import { addClipEffect, batch, removeClipEffect, toggleClipEffect, updateClipEffectParams, updateElements, type Command } from "#/engine/commands";
import { EFFECT_DEFINITIONS, RETIME_MAX, RETIME_MIN, SPEED_CURVE_MAX_POINTS, isRetimable, type Effect, type ParamValues, type TimelineElement } from "#/engine/model";
import {
  SPEED_RAMP_PRESETS, SPEED_RAMP_PRESET_IDS, currentRampShape, elementEnd, presetShape, rampShapeProblem, retimeForShape, timelineDurationForSourceSpan,
  visibleSourceRange, type LocatedElement, type RampShapePoint, type SpeedRampPresetId,
} from "#/engine/timeline";
import { defineTool, ok, toSec, ToolError, type ToolEnv } from "./env";
import { effectSpecs, specList, validateParamValues } from "./params";
import type { AgentTool, JsonSchema } from "./types";

type Decorated = TimelineElement & { effects?: Effect[] };

const effectOf = (element: TimelineElement, type: string): Effect | undefined => (element as Decorated).effects?.find((e) => e.type === type);

function requireMediaClip(located: LocatedElement, what: string): void {
  if (located.element.type !== "video" && located.element.type !== "image") {
    throw new ToolError(`${what} applies to video and image clips, not ${located.element.type}.`, "Pick a video or image clip from get_timeline.");
  }
}

const ELEMENT_IDS: JsonSchema = { type: "array", items: { type: "string" }, description: "Video or image clip ids from get_timeline." };

/** Creates the clip's single effect of `type` on first use, edits it afterwards, so repeated calls never stack. */
function upsertEffect(env: ToolEnv, input: { located: LocatedElement; type: string; params: ParamValues }): Command[] {
  const existing = effectOf(input.located.element, input.type);
  if (existing) {
    return [
      ...(Object.keys(input.params).length > 0 ? [updateClipEffectParams(input.located.ref, existing.id, input.params)] : []),
      ...(existing.enabled ? [] : [toggleClipEffect(input.located.ref, existing.id)]),
    ];
  }
  const effectId = env.editor.newId();
  return [addClipEffect({ ref: input.located.ref, effectType: input.type, effectId }), ...(Object.keys(input.params).length > 0 ? [updateClipEffectParams(input.located.ref, effectId, input.params)] : [])];
}

const CHROMA_SPECS = effectSpecs("chroma-key");

const setChromaKey = defineTool<{ elementIds: string[]; keyColor?: string; similarity?: number; smoothness?: number; spill?: number; remove?: boolean }>({
  name: "set_chroma_key",
  description:
    `Green screen: make a key colour transparent so the layers below show through. Works on video and image clips; put the keyed clip on an overlay track above the footage it should reveal (on the main track the project background shows instead). One chroma-key effect per clip (created on first use, edited afterwards). Keys in Cb/Cr, so shadowed parts of the screen key like lit ones. Parameters: ${specList(CHROMA_SPECS)}. keyColor defaults to #00ff00; similarity (0-100, default 30) is how far from the key colour still counts as background; smoothness (0-100, default 10) softens the matte edge; spill (0-100, default 50) removes the key colour's cast from the subject's edges. \`remove: true\` deletes the effect. Only the keys you pass change. All clips change as one undo step.`,
  inputSchema: {
    type: "object",
    properties: {
      elementIds: ELEMENT_IDS,
      keyColor: { type: "string", description: "Hex colour to remove, e.g. #00ff00 (green) or #0000ff (blue)." },
      similarity: { type: "number", minimum: 0, maximum: 100 },
      smoothness: { type: "number", minimum: 0, maximum: 100 },
      spill: { type: "number", minimum: 0, maximum: 100 },
      remove: { type: "boolean", description: "Remove the chroma key from these clips." },
    },
    required: ["elementIds"],
  },
  readOnly: false,
  run(input, env) {
    env.requireProject();
    if (input.elementIds.length === 0) throw new ToolError("elementIds is empty.", "Pass at least one clip id.");
    const targets = env.requireMany(input.elementIds);
    targets.forEach((t) => requireMediaClip(t, "Chroma key"));
    if (input.remove === true) {
      const commands = targets.flatMap((t) => { const e = effectOf(t.element, "chroma-key"); return e ? [removeClipEffect(t.ref, e.id)] : []; });
      if (commands.length === 0) throw new ToolError("None of those clips has a chroma key.", "Nothing to remove.");
      env.editor.execute(batch("Remove chroma key", commands));
      return ok(`Removed the chroma key from ${commands.length} clip(s).`, { elementIds: input.elementIds });
    }
    const raw: Record<string, unknown> = {};
    for (const key of ["keyColor", "similarity", "smoothness", "spill"] as const) if (input[key] !== undefined) raw[key] = input[key];
    const params = Object.keys(raw).length > 0 ? validateParamValues({ specs: CHROMA_SPECS, values: raw, subject: "chroma key" }) : {};
    env.editor.execute(batch("Chroma key", targets.flatMap((located) => upsertEffect(env, { located, type: "chroma-key", params }))));
    const clips = targets.map((t) => {
      const effect = effectOf(env.require(t.element.id).element, "chroma-key");
      return { elementId: t.element.id, effectId: effect?.id, params: effect?.params };
    });
    const onMain = targets.filter((t) => t.ref.trackId === env.tracks.main.id).map((t) => t.element.id);
    const note = onMain.length > 0 ? ` ${onMain.join(", ")} sit on the main track, so the keyed area shows the project background; move the clip to an overlay track above other footage to reveal it.` : "";
    return ok(`Chroma key set on ${clips.length} clip(s).${note}`, { clips, defaults: Object.fromEntries((EFFECT_DEFINITIONS["chroma-key"]?.params ?? []).map((p) => [p.key, p.default])) });
  },
});

interface SetSpeedRampInput {
  elementId: string;
  preset?: SpeedRampPresetId;
  points?: Array<{ position: number; speed: number }>;
  clear?: boolean;
  maintainPitch?: boolean;
}

const setSpeedRamp = defineTool<SetSpeedRampInput>({
  name: "set_speed_ramp",
  description:
    `Speed ramp: change playback speed smoothly over a video or audio clip instead of one constant speed (set_speed). Give a \`preset\` (${SPEED_RAMP_PRESET_IDS.map((id) => `${id} = ${SPEED_RAMP_PRESETS[id].name}`).join("; ")}) or custom \`points\`: 2-${SPEED_CURVE_MAX_POINTS} {position, speed} pairs, position 0-1 along the clip's currently visible source (strictly increasing; speed ${RETIME_MIN}-${RETIME_MAX}, 1 = normal), speed changing linearly between points and held flat beyond the first and last. The ramp is tied to the footage, so trimming or splitting later keeps it on the same moments. The clip's timeline duration is re-derived from the ramp (slow parts take longer) and stops short of the next clip on the track (data.limitedByNeighbour). Audio follows the ramp in short constant-speed pieces; maintainPitch keeps its pitch. \`clear: true\` returns to 1x. One undo step.`,
  inputSchema: {
    type: "object",
    properties: {
      elementId: { type: "string" },
      preset: { type: "string", enum: [...SPEED_RAMP_PRESET_IDS] },
      points: {
        type: "array", description: `2-${SPEED_CURVE_MAX_POINTS} points.`,
        items: { type: "object", properties: { position: { type: "number", minimum: 0, maximum: 1 }, speed: { type: "number", minimum: RETIME_MIN, maximum: RETIME_MAX } }, required: ["position", "speed"] },
      },
      clear: { type: "boolean", description: "Remove the ramp and play at 1x." },
      maintainPitch: { type: "boolean" },
    },
    required: ["elementId"],
  },
  readOnly: false,
  run(input, env) {
    env.requireProject();
    const located = env.require(input.elementId);
    const element = located.element;
    if (!isRetimable(element) || (element.type !== "video" && element.type !== "audio")) {
      throw new ToolError(`Speed ramps apply to video and audio clips, not ${element.type}.`, "Pick a video or audio clip from get_timeline.");
    }
    const chosen = [input.preset !== undefined, input.points !== undefined, input.clear === true].filter(Boolean).length;
    if (chosen !== 1) throw new ToolError("Pass exactly one of preset, points or clear.", `Presets: ${SPEED_RAMP_PRESET_IDS.join(", ")}.`);
    const before = { duration: element.duration, shape: currentRampShape(element) };
    let retime;
    if (input.clear === true) {
      retime = undefined;
    } else {
      let shape: RampShapePoint[];
      if (input.preset !== undefined) {
        if (!SPEED_RAMP_PRESET_IDS.includes(input.preset)) throw new ToolError(`Unknown preset "${input.preset}".`, `Use one of: ${SPEED_RAMP_PRESET_IDS.join(", ")}.`);
        shape = presetShape(input.preset);
      } else {
        shape = input.points ?? [];
      }
      const problem = rampShapeProblem(shape);
      if (problem) throw new ToolError(`Invalid speed ramp: ${problem}.`, "Example points: [{position:0,speed:1},{position:0.5,speed:0.25},{position:1,speed:1}].");
      for (const p of shape) {
        if (p.speed < RETIME_MIN || p.speed > RETIME_MAX) throw new ToolError(`Speed ${p.speed} is outside ${RETIME_MIN}-${RETIME_MAX}.`, "Use a speed within range.");
      }
      retime = retimeForShape({ element, shape, maintainPitch: input.maintainPitch }) ?? undefined;
      if (!retime) throw new ToolError("The clip is too short to place those ramp points.", "Use fewer points or a longer clip.");
    }
    const expectedDuration = timelineDurationForSourceSpan(visibleSourceRange(element).to - element.trimStart, retime, element.trimStart);
    env.editor.execute(updateElements([{ ref: located.ref, patch: { retime } }], "Speed ramp"));
    const after = env.require(input.elementId).element;
    const limited = after.duration < expectedDuration - 1;
    const data = {
      elementId: after.id, ramp: input.clear === true ? null : (input.preset ?? "custom"), shape: currentRampShape(after as typeof element),
      start: toSec(after.startTime), end: toSec(elementEnd(after)), duration: toSec(after.duration), previousDuration: toSec(before.duration),
      limitedByNeighbour: limited,
    };
    return ok(
      input.clear === true
        ? `Cleared the speed ramp on ${after.id}; duration ${data.previousDuration}s -> ${data.duration}s.`
        : `Applied ${input.preset ?? "a custom"} speed ramp to ${after.id}; duration ${data.previousDuration}s -> ${data.duration}s${limited ? " (limited by the next clip; the tail of the source is trimmed)" : ""}.`,
      data,
    );
  },
});

export const VFX_TOOLS: AgentTool[] = [setChromaKey, setSpeedRamp];
