import {
  addClipEffect, addMask, batch, removeClipEffect, removeKeyframeCommand, removeMask, toggleClipEffect, upsertKeyframeCommand,
  updateClipEffectParams, updateMaskParams, type Command,
} from "#/engine/commands";
import {
  EFFECT_DEFINITIONS, MASK_DEFINITIONS, isMaskable, isVisualElement, type AnimationBinding, type Effect, type Mask, type MaskType,
  type ParamValue, type ParamValues, type TimelineElement,
} from "#/engine/model";
import { keyframeIdAtTime } from "#/engine/animation";
import { mediaTime } from "#/engine/time";
import { elementEnd, type LocatedElement } from "#/engine/timeline";
import { defineTool, ok, toSec, ToolError, type ToolEnv } from "./env";
import { keyframesOf } from "./describe";
import {
  animationPathFor, effectSpecs, maskSpecs, paramEditCommand, paramSpecsFor, specList, validateParamValues,
} from "./params";
import type { AgentTool } from "./types";

type Decorated = TimelineElement & { effects?: Effect[]; masks?: Mask[] };

const setParams = defineTool<{ elementId?: string; elementIds?: string[]; params: Record<string, unknown> }>({
  name: "set_params",
  description:
    "Set parameters on one clip (`elementId`) or several (`elementIds`) using the real param keys: transform.positionX / transform.positionY (px from canvas center, +y down), transform.scaleX / transform.scaleY (1 = 100%), transform.rotate (degrees), opacity (0-1), blendMode, volume (dB, 0 = unchanged, -60..20), muted (bool), and for text: content, fontSize, fontFamily, color (#rrggbb), textAlign, fontWeight, fontStyle, textDecoration, letterSpacing, lineHeight, background.enabled/color/cornerRadius/paddingX/paddingY/offsetX/offsetY; graphics: fill, stroke, strokeWidth, cornerRadius, sides, points, depth. Validated per clip; an invalid key or value changes nothing and the error lists the valid keys. If a key already has keyframes and the playhead (seconds) is inside the clip, a keyframe is written at the playhead instead of the static value (reported in data.keyframedAtPlayhead).",
  inputSchema: {
    type: "object",
    properties: {
      elementId: { type: "string" },
      elementIds: { type: "array", items: { type: "string" } },
      params: { type: "object", description: "Param key -> new value." },
    },
    required: ["params"],
  },
  readOnly: false,
  run(input, env) {
    env.requireProject();
    if ((input.elementId === undefined) === (input.elementIds === undefined)) {
      throw new ToolError("Pass exactly one of elementId or elementIds.", "Use elementId for one clip, elementIds for several.");
    }
    const ids = input.elementIds ?? [input.elementId as string];
    if (ids.length === 0) throw new ToolError("elementIds is empty.", "Pass at least one element id.");
    const targets = env.requireMany(ids);
    const playhead = env.playhead;
    const planned = targets.map((target) => {
      const values = validateParamValues({
        specs: paramSpecsFor(target.element), values: input.params, subject: `${target.element.type} "${target.element.id}"`,
      });
      return { target, values, ...paramEditCommand({ element: target.element, ref: target.ref, values, playhead, label: "Set parameters" }) };
    });
    const commands: Command[] = planned.map((p) => p.command);
    env.editor.execute(commands.length === 1 ? (commands[0] as Command) : batch("Set parameters", commands));
    const updated = planned.map((p) => ({ elementId: p.target.element.id, applied: p.values, keyframedAtPlayhead: p.keyframed }));
    const note = updated.some((u) => u.keyframedAtPlayhead.length > 0) ? " Keys with existing keyframes got a keyframe at the playhead." : "";
    return ok(`Updated ${Object.keys(input.params).join(", ")} on ${updated.length} clip(s).${note}`, { updated });
  },
});

function localTime(env: ToolEnv, located: LocatedElement, timelineSeconds: number): number {
  const element = located.element;
  const time = env.snap(timelineSeconds);
  if (time < element.startTime || time > elementEnd(element)) {
    throw new ToolError(
      `Time ${toSec(time)}s is outside clip "${element.id}" (${toSec(element.startTime)}s-${toSec(elementEnd(element))}s).`,
      "Keyframe times are timeline SECONDS and must fall inside the clip.",
    );
  }
  return time - element.startTime;
}

function requireAnimatable(located: LocatedElement, property: string): void {
  const specs = paramSpecsFor(located.element);
  if (!specs.some((s) => s.key === property)) {
    throw new ToolError(
      `"${property}" is not an animatable parameter of ${located.element.type} "${located.element.id}".`,
      `Valid properties: ${specList(specs)}.`,
    );
  }
}

const addKeyframe = defineTool<{ elementId: string; property: string; time: number; value: unknown; interpolation?: "linear" | "hold" | "bezier" }>({
  name: "add_keyframe",
  description:
    "Add (or update) a keyframe so a parameter animates over time. `property` is a param key (see set_params: opacity, transform.positionX, transform.scaleX, volume, color, ...). `time` is a timeline time in SECONDS inside the clip (snapped to a frame). `value` must be valid for the property. `interpolation` of the segment leaving this key: linear (default), hold or bezier. Returns keyframeId and the snapped time.",
  inputSchema: {
    type: "object",
    properties: {
      elementId: { type: "string" },
      property: { type: "string" },
      time: { type: "number", minimum: 0, description: "Timeline SECONDS." },
      value: {},
      interpolation: { type: "string", enum: ["linear", "hold", "bezier"] },
    },
    required: ["elementId", "property", "time", "value"],
  },
  readOnly: false,
  run(input, env) {
    env.requireProject();
    const located = env.require(input.elementId);
    requireAnimatable(located, input.property);
    const checked = validateParamValues({
      specs: paramSpecsFor(located.element), values: { [input.property]: input.value }, subject: `${located.element.type} "${input.elementId}"`,
    });
    const value = checked[input.property] as ParamValue;
    const local = localTime(env, located, input.time);
    const path = animationPathFor(located.element, input.property);
    env.editor.execute(upsertKeyframeCommand({ ref: located.ref, path, time: local, value, interpolation: input.interpolation }));
    const after = env.require(input.elementId).element;
    const data = {
      elementId: after.id, property: input.property,
      keyframeId: keyframeIdAtTime(after.animations, path, mediaTime(local)),
      time: toSec(after.startTime + local), localTime: toSec(local), value,
      keyframeCount: keyframesOf(after.animations?.[path]).length,
    };
    return ok(`Keyframe on ${input.property} at ${data.time}s = ${JSON.stringify(value)} (${data.keyframeCount} key(s) total).`, data);
  },
});

function rawKeys(binding: AnimationBinding | undefined): Array<{ id: string; time: number }> {
  if (!binding) return [];
  const channel = binding.kind === "channel" ? binding.channel : binding.channels.r;
  return channel.keys.map((k) => ({ id: k.id, time: k.time }));
}

const removeKeyframe = defineTool<{ elementId: string; property: string; keyframeId?: string; time?: number }>({
  name: "remove_keyframe",
  description:
    "Remove one keyframe of a property, identified by `keyframeId` (from get_element) or by `time` (timeline SECONDS, snapped to a frame). Removing the last keyframe keeps the value it had there as the static value, so nothing jumps.",
  inputSchema: {
    type: "object",
    properties: {
      elementId: { type: "string" },
      property: { type: "string" },
      keyframeId: { type: "string" },
      time: { type: "number", minimum: 0, description: "Timeline SECONDS." },
    },
    required: ["elementId", "property"],
  },
  readOnly: false,
  run(input, env) {
    env.requireProject();
    if ((input.keyframeId === undefined) === (input.time === undefined)) {
      throw new ToolError("Pass exactly one of keyframeId or time.", "Use get_element to see keyframe ids and times.");
    }
    const located = env.require(input.elementId);
    const path = animationPathFor(located.element, input.property);
    const keys = rawKeys(located.element.animations?.[path]);
    if (keys.length === 0) {
      throw new ToolError(`"${input.property}" has no keyframes on "${input.elementId}".`, "Use get_element to see which properties are animated.");
    }
    const target = input.keyframeId !== undefined
      ? keys.find((k) => k.id === input.keyframeId)
      : keys.find((k) => k.time === localTime(env, located, input.time as number));
    if (!target) {
      const listing = keys.map((k) => `${k.id} @ ${toSec(located.element.startTime + k.time)}s`).join(", ");
      throw new ToolError("No matching keyframe.", `Keyframes on ${input.property}: ${listing}.`);
    }
    env.editor.execute(removeKeyframeCommand({ ref: located.ref, path, keyframeId: target.id, localTime: target.time }));
    const remaining = rawKeys(env.require(input.elementId).element.animations?.[path]).length;
    return ok(`Removed keyframe ${target.id} from ${input.property}; ${remaining} left.`, { keyframeId: target.id, property: input.property, remaining });
  },
});

function requireEffectHost(located: LocatedElement): Decorated {
  if (!isVisualElement(located.element)) {
    throw new ToolError(`Effects apply to video, image, text and graphic clips, not ${located.element.type}.`, "For a scene-wide effect use insert_effect_layer.");
  }
  return located.element as Decorated;
}

function requireEffect(located: LocatedElement, effectId: string): Effect {
  const effects = (located.element as Decorated).effects ?? [];
  const found = effects.find((e) => e.id === effectId);
  if (!found) {
    throw new ToolError(`No effect "${effectId}" on "${located.element.id}".`, `Effects on this clip: ${effects.map((e) => `${e.id} (${e.type})`).join(", ") || "none"}.`);
  }
  return found;
}

const addEffect = defineTool<{ elementId: string; effectType: string; params?: Record<string, unknown> }>({
  name: "add_effect",
  description: `Attach an effect to one clip. Available effects: ${Object.values(EFFECT_DEFINITIONS).map((d) => `${d.type} (${d.params.map((p) => p.key).join(", ")})`).join("; ")}. \`params\` are the effect's real keys (blur intensity 0-100). Returns effectId.`,
  inputSchema: {
    type: "object",
    properties: {
      elementId: { type: "string" },
      effectType: { type: "string", enum: Object.keys(EFFECT_DEFINITIONS) },
      params: { type: "object" },
    },
    required: ["elementId", "effectType"],
  },
  readOnly: false,
  run(input, env) {
    env.requireProject();
    const located = env.require(input.elementId);
    requireEffectHost(located);
    const params: ParamValues | undefined = input.params
      ? validateParamValues({ specs: effectSpecs(input.effectType), values: input.params, subject: `${input.effectType} effect` })
      : undefined;
    const effectId = env.editor.newId();
    const commands: Command[] = [addClipEffect({ ref: located.ref, effectType: input.effectType, effectId })];
    if (params) commands.push(updateClipEffectParams(located.ref, effectId, params));
    env.editor.execute(batch("Add effect", commands));
    const effect = requireEffect(env.require(input.elementId), effectId);
    return ok(`Added ${effect.type} effect ${effectId} to ${input.elementId}.`, { effectId, type: effect.type, params: effect.params });
  },
});

const removeEffect = defineTool<{ elementId: string; effectId: string }>({
  name: "remove_effect",
  description: "Remove an effect from a clip by effectId (see get_element).",
  inputSchema: { type: "object", properties: { elementId: { type: "string" }, effectId: { type: "string" } }, required: ["elementId", "effectId"] },
  readOnly: false,
  run(input, env) {
    env.requireProject();
    const located = env.require(input.elementId);
    requireEffect(located, input.effectId);
    env.editor.execute(removeClipEffect(located.ref, input.effectId));
    return ok(`Removed effect ${input.effectId} from ${input.elementId}.`, { elementId: input.elementId, effectId: input.effectId });
  },
});

const setEffectParams = defineTool<{ elementId: string; effectId: string; params?: Record<string, unknown>; enabled?: boolean }>({
  name: "set_effect_params",
  description: "Change an effect's parameters (real keys, e.g. blur intensity 0-100) and/or switch it on or off with `enabled`. Invalid keys list the valid ones.",
  inputSchema: {
    type: "object",
    properties: { elementId: { type: "string" }, effectId: { type: "string" }, params: { type: "object" }, enabled: { type: "boolean" } },
    required: ["elementId", "effectId"],
  },
  readOnly: false,
  run(input, env) {
    env.requireProject();
    if (input.params === undefined && input.enabled === undefined) {
      throw new ToolError("Nothing to change.", "Pass params and/or enabled.");
    }
    const located = env.require(input.elementId);
    const effect = requireEffect(located, input.effectId);
    const commands: Command[] = [];
    if (input.params) {
      const applied = validateParamValues({ specs: effectSpecs(effect.type), values: input.params, subject: `${effect.type} effect` });
      commands.push(updateClipEffectParams(located.ref, effect.id, applied));
    }
    if (input.enabled !== undefined && input.enabled !== effect.enabled) commands.push(toggleClipEffect(located.ref, effect.id));
    if (commands.length > 0) env.editor.execute(batch("Edit effect", commands));
    const after = requireEffect(env.require(input.elementId), input.effectId);
    return ok(`Effect ${after.id} updated.`, { effectId: after.id, params: after.params, enabled: after.enabled });
  },
});

const MASK_TYPES = Object.keys(MASK_DEFINITIONS);

const addMaskTool = defineTool<{ elementId: string; maskType: MaskType; params?: Record<string, unknown> }>({
  name: "add_mask",
  description: `Mask a video, image or graphic clip so only a shape is visible. maskType: ${MASK_TYPES.join(", ")}. \`params\` use the real keys: centerX/centerY (-1..1 of the clip), width/height (fraction of the clip, 0.01-4), rotation (degrees 0-360), feather (px), inverted (bool), strokeColor, strokeWidth. Returns maskId.`,
  inputSchema: {
    type: "object",
    properties: { elementId: { type: "string" }, maskType: { type: "string", enum: MASK_TYPES }, params: { type: "object" } },
    required: ["elementId", "maskType"],
  },
  readOnly: false,
  run(input, env) {
    env.requireProject();
    const located = env.require(input.elementId);
    if (!isMaskable(located.element)) {
      throw new ToolError(`Masks apply to video, image and graphic clips, not ${located.element.type}.`, "Pick a clip of one of those kinds.");
    }
    const params = input.params
      ? validateParamValues({ specs: maskSpecs(input.maskType), values: input.params, subject: `${input.maskType} mask` })
      : undefined;
    const before = new Set(((located.element as Decorated).masks ?? []).map((m) => m.id));
    const final = env.atomically("Add mask", () => {
      env.editor.execute(addMask(located.ref, input.maskType));
      const created = ((env.require(input.elementId).element as Decorated).masks ?? []).find((m) => !before.has(m.id));
      if (!created) throw new ToolError("The mask could not be added.", "Check the clip with get_element and retry.");
      if (params) env.editor.execute(updateMaskParams(located.ref, created.id, params));
      return ((env.require(input.elementId).element as Decorated).masks ?? []).find((m) => m.id === created.id) as Mask;
    });
    return ok(`Added ${input.maskType} mask ${final.id} to ${input.elementId}.`, { maskId: final.id, type: final.type, params: final.params });
  },
});

const removeMaskTool = defineTool<{ elementId: string; maskId: string }>({
  name: "remove_mask",
  description: "Remove a mask from a clip by maskId (see get_element).",
  inputSchema: { type: "object", properties: { elementId: { type: "string" }, maskId: { type: "string" } }, required: ["elementId", "maskId"] },
  readOnly: false,
  run(input, env) {
    env.requireProject();
    const located = env.require(input.elementId);
    const masks = (located.element as Decorated).masks ?? [];
    if (!masks.some((m) => m.id === input.maskId)) {
      throw new ToolError(`No mask "${input.maskId}" on "${input.elementId}".`, `Masks on this clip: ${masks.map((m) => `${m.id} (${m.type})`).join(", ") || "none"}.`);
    }
    env.editor.execute(removeMask(located.ref, input.maskId));
    return ok(`Removed mask ${input.maskId} from ${input.elementId}.`, { elementId: input.elementId, maskId: input.maskId });
  },
});

export const PROP_TOOLS: AgentTool[] = [
  setParams, addKeyframe, removeKeyframe, addEffect, removeEffect, setEffectParams, addMaskTool, removeMaskTool,
];
