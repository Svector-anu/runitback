import { batch, setTextAnimationCommand, type Command } from "#/engine/commands";
import { TEXT_ANIMATION_PRESETS, type ParamValues, type TextAnimationPreset, type TextAnimationSpec } from "#/engine/model";
import { maxTextAnimationDuration } from "#/engine/animation";
import type { LocatedElement } from "#/engine/timeline";
import { defineTool, ok, ToolError, toSec, type ToolEnv } from "./env";
import { paramEditCommand, paramSpecsFor, validateParamValues } from "./params";
import type { AgentTool, JsonSchema } from "./types";

const TEXT_IDS: JsonSchema = { type: "array", items: { type: "string" }, description: "Text clip ids from get_timeline." };
const DEFAULT_PHASE_SECONDS = 0.5;

function requireText(located: LocatedElement): void {
  if (located.element.type !== "text") {
    throw new ToolError(`"${located.element.id}" is a ${located.element.type} clip, not text.`, "Pick a text clip (insert_text creates one).");
  }
}

/** Maps a nested style object onto the flat param keys, rejecting keys it does not know. */
function nested(input: { prefix: string; source: Record<string, unknown> | undefined; keys: Record<string, string>; enabledKey?: string; subject: string }): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const { source } = input;
  if (!source) return out;
  for (const [key, value] of Object.entries(source)) {
    if (key === "enabled" && input.enabledKey) out[input.enabledKey] = value;
    else if (input.keys[key]) out[input.keys[key] as string] = value;
    else throw new ToolError(`"${key}" is not a valid ${input.subject} setting.`, `Valid keys: ${[...Object.keys(input.keys), ...(input.enabledKey ? ["enabled"] : [])].join(", ")}.`);
  }
  if (input.enabledKey && !("enabled" in source) && Object.keys(source).length > 0) out[input.enabledKey] = true;
  return out;
}

interface TextStyleInput {
  elementIds: string[];
  color?: string; fontSize?: number; fontFamily?: string; fontWeight?: "normal" | "bold"; fontStyle?: "normal" | "italic";
  textAlign?: "left" | "center" | "right"; letterSpacing?: number; lineHeight?: number;
  stroke?: Record<string, unknown>; shadow?: Record<string, unknown>; background?: Record<string, unknown>;
}

const setTextStyle = defineTool<TextStyleInput>({
  name: "set_text_style",
  description:
    "Style one or more text clips in a single undo step. Plain keys: color (#rrggbb), fontSize (relative to a 90-unit-tall canvas), fontFamily, fontWeight, fontStyle, textAlign, letterSpacing, lineHeight. `stroke` {width, color}: an outline around the letters (width in px at font size 15, scales with size; width 0 removes it). `shadow` {offsetX, offsetY, blur, color (#rrggbbaa allowed), enabled}: a drop shadow, switched on by passing any key, off with {enabled:false}. `background` {color, paddingX, paddingY, cornerRadius 0-100, enabled}: a box behind the text. Only the keys you pass change. Keys that already have keyframes get a keyframe at the playhead instead (see set_params).",
  inputSchema: {
    type: "object",
    properties: {
      elementIds: TEXT_IDS,
      color: { type: "string" }, fontSize: { type: "number" }, fontFamily: { type: "string" },
      fontWeight: { type: "string", enum: ["normal", "bold"] }, fontStyle: { type: "string", enum: ["normal", "italic"] },
      textAlign: { type: "string", enum: ["left", "center", "right"] }, letterSpacing: { type: "number" }, lineHeight: { type: "number" },
      stroke: { type: "object", description: "{ width, color }" },
      shadow: { type: "object", description: "{ offsetX, offsetY, blur, color, enabled }" },
      background: { type: "object", description: "{ color, paddingX, paddingY, cornerRadius, enabled }" },
    },
    required: ["elementIds"],
  },
  readOnly: false,
  run(input, env) {
    env.requireProject();
    if (input.elementIds.length === 0) throw new ToolError("elementIds is empty.", "Pass at least one text clip id.");
    const raw: Record<string, unknown> = {
      ...(input.color !== undefined ? { color: input.color } : {}),
      ...(input.fontSize !== undefined ? { fontSize: input.fontSize } : {}),
      ...(input.fontFamily !== undefined ? { fontFamily: input.fontFamily } : {}),
      ...(input.fontWeight !== undefined ? { fontWeight: input.fontWeight } : {}),
      ...(input.fontStyle !== undefined ? { fontStyle: input.fontStyle } : {}),
      ...(input.textAlign !== undefined ? { textAlign: input.textAlign } : {}),
      ...(input.letterSpacing !== undefined ? { letterSpacing: input.letterSpacing } : {}),
      ...(input.lineHeight !== undefined ? { lineHeight: input.lineHeight } : {}),
      ...nested({ prefix: "stroke", source: input.stroke, keys: { width: "stroke.width", color: "stroke.color" }, subject: "stroke" }),
      ...nested({
        prefix: "shadow", source: input.shadow, enabledKey: "shadow.enabled", subject: "shadow",
        keys: { offsetX: "shadow.offsetX", offsetY: "shadow.offsetY", blur: "shadow.blur", color: "shadow.color" },
      }),
      ...nested({
        prefix: "background", source: input.background, enabledKey: "background.enabled", subject: "background",
        keys: { color: "background.color", paddingX: "background.paddingX", paddingY: "background.paddingY", cornerRadius: "background.cornerRadius" },
      }),
    };
    if (Object.keys(raw).length === 0) throw new ToolError("Nothing to change.", "Pass at least one style key (color, stroke, shadow, background, ...).");
    const targets = env.requireMany(input.elementIds);
    targets.forEach(requireText);
    const values: ParamValues = validateParamValues({ specs: paramSpecsFor(targets[0]!.element), values: raw, subject: "text style" });
    const planned = targets.map((t) => ({ t, ...paramEditCommand({ element: t.element, ref: t.ref, values, playhead: env.playhead, label: "Text style" }) }));
    env.editor.execute(batch("Text style", planned.map((p): Command => p.command)));
    return ok(`Styled ${targets.length} text clip(s).`, { elementIds: targets.map((t) => t.element.id), applied: values });
  },
});

interface PhaseInput { preset: TextAnimationPreset | "none"; duration?: number }

const PHASE_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    preset: { type: "string", enum: [...TEXT_ANIMATION_PRESETS, "none"] },
    duration: { type: "number", minimum: 0.04, description: "SECONDS (default 0.5), clamped to half of the clip." },
  },
  required: ["preset"],
};

const setTextAnimation = defineTool<{ elementIds: string[]; in?: PhaseInput; out?: PhaseInput }>({
  name: "set_text_animation",
  description:
    `Animate a text clip's entrance (\`in\`) and/or exit (\`out\`) with a preset: ${TEXT_ANIMATION_PRESETS.join(", ")} ("none" removes that side). fade = opacity; slide-up = rises into place (falls away on exit) while fading; pop = scales up with a small overshoot; typewriter = letters appear one by one (erase on exit); type-caret = typewriter with a caret that blinks once the text is complete; blur-in = sharpens from a blur while fading in and rising slightly (blurs away on exit); stagger-words = words enter one after another, each rising and fading in; count-up = the number in the text counts up from 0 (a clip reading "$12,400+" keeps its $, commas and +; fails if the text has no number). A side you leave out keeps its current preset. Presets are written as real keyframes on opacity, transform.positionY, transform.scaleX/Y, reveal, blur, wordReveal and countValue, replacing any keyframes already on those parameters; other keyframes are untouched. \`duration\` is in SECONDS. One undo step for all clips.`,
  inputSchema: {
    type: "object",
    properties: { elementIds: TEXT_IDS, in: PHASE_SCHEMA, out: PHASE_SCHEMA },
    required: ["elementIds"],
  },
  readOnly: false,
  run(input, env) {
    env.requireProject();
    if (input.in === undefined && input.out === undefined) throw new ToolError("Nothing to animate.", "Pass `in` and/or `out`, each { preset, duration }.");
    const targets = env.requireMany(input.elementIds);
    targets.forEach(requireText);
    const spec = (phase: PhaseInput | undefined, env2: ToolEnv): TextAnimationSpec | null | undefined => {
      if (!phase) return undefined;
      if (phase.preset === "none") return null;
      return { preset: phase.preset, duration: env2.snapDuration(phase.duration ?? DEFAULT_PHASE_SECONDS) };
    };
    const inSpec = spec(input.in, env);
    const outSpec = spec(input.out, env);
    const short = targets.find((t) => maxTextAnimationDuration(t.element.duration) < 1);
    if (short) throw new ToolError(`"${short.element.id}" is too short for a text animation.`, "Lengthen the clip first.");
    env.editor.execute(batch("Text animation", targets.map((t) => setTextAnimationCommand({
      ref: t.ref,
      ...(inSpec !== undefined ? { in: inSpec === null ? null : { preset: inSpec.preset, duration: inSpec.duration } } : {}),
      ...(outSpec !== undefined ? { out: outSpec === null ? null : { preset: outSpec.preset, duration: outSpec.duration } } : {}),
    }))));
    const applied = targets.map((t) => {
      const state = (env.require(t.element.id).element as { textAnimation?: { in?: { preset: string; duration: number }; out?: { preset: string; duration: number } } }).textAnimation;
      return {
        elementId: t.element.id,
        in: state?.in ? { preset: state.in.preset, duration: toSec(state.in.duration) } : null,
        out: state?.out ? { preset: state.out.preset, duration: toSec(state.out.duration) } : null,
      };
    });
    return ok(`Updated the text animation on ${applied.length} clip(s).`, { clips: applied });
  },
});

export const TEXT_TOOLS: AgentTool[] = [setTextStyle, setTextAnimation];
