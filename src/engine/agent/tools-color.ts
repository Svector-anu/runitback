import { addClipEffect, batch, removeClipEffect, setElementParams, updateClipEffectParams, type Command } from "#/engine/commands";
import {
  EFFECT_DEFINITIONS, FILTER_PRESETS, FILTER_PRESET_IDS, defaultsOf, isVisualElement, type Effect, type FilterPresetId, type ParamValues,
  type TimelineElement,
} from "#/engine/model";
import type { LocatedElement } from "#/engine/timeline";
import { defineTool, ok, ToolError, type ToolEnv } from "./env";
import { effectSpecs, specList, validateParamValues } from "./params";
import type { AgentTool, JsonSchema } from "./types";

const ADJUST_PARAMS = EFFECT_DEFINITIONS.adjust?.params ?? [];
const NEUTRAL: ParamValues = defaultsOf(ADJUST_PARAMS);
const ADJUST_SPECS = effectSpecs("adjust");

type Decorated = TimelineElement & { effects?: Effect[] };

const ELEMENT_IDS: JsonSchema = {
  type: "array",
  items: { type: "string" },
  description: "Clip ids from get_timeline (video, image, text or graphic clips, or an `adjust` effect layer for a scene-wide look).",
};

function requireTarget(located: LocatedElement): void {
  const element = located.element;
  const isAdjustLayer = element.type === "effect" && element.effectType === "adjust";
  if (!isVisualElement(element) && !isAdjustLayer) {
    throw new ToolError(
      `Colour adjustments apply to video, image, text and graphic clips, not ${element.type}.`,
      "Pick a visual clip, or insert_effect_layer with effectType \"adjust\" for a scene-wide look.",
    );
  }
}

const adjustEffectOf = (element: TimelineElement): Effect | undefined => (element as Decorated).effects?.find((e) => e.type === "adjust");

/** Commands that set the clip's adjust parameters: merged over its current ones, or over neutral when `reset`. */
function commandsFor(env: ToolEnv, located: LocatedElement, values: ParamValues, reset: boolean): Command[] {
  const params = reset ? { ...NEUTRAL, ...values } : values;
  if (located.element.type === "effect") return [setElementParams({ refs: [located.ref], params, label: "Colour adjust" })];
  const existing = adjustEffectOf(located.element);
  if (existing) return [updateClipEffectParams(located.ref, existing.id, params)];
  const effectId = env.editor.newId();
  return [addClipEffect({ ref: located.ref, effectType: "adjust", effectId }), updateClipEffectParams(located.ref, effectId, params)];
}

function currentAdjust(env: ToolEnv, elementId: string): ParamValues {
  const element = env.require(elementId).element;
  return element.type === "effect" ? element.params : (adjustEffectOf(element)?.params ?? NEUTRAL);
}

const setColorAdjust = defineTool<{ elementIds: string[]; params: Record<string, unknown>; reset?: boolean }>({
  name: "set_color_adjust",
  description: `Colour-correct clips with one adjust effect per clip (created on first use, edited afterwards, so repeated calls never stack). params keys, all 0 = unchanged: ${specList(ADJUST_SPECS)}. Only the keys you pass change unless \`reset\` is true (every other key goes back to 0). All clips change as one undo step.`,
  inputSchema: {
    type: "object",
    properties: {
      elementIds: ELEMENT_IDS,
      params: { type: "object", description: "Adjust values, e.g. { temperature: 30, saturation: 15 }." },
      reset: { type: "boolean", description: "Zero every adjust key not listed in params." },
    },
    required: ["elementIds", "params"],
  },
  readOnly: false,
  run(input, env) {
    env.requireProject();
    if (input.elementIds.length === 0) throw new ToolError("elementIds is empty.", "Pass at least one clip id.");
    const values = validateParamValues({ specs: ADJUST_SPECS, values: input.params, subject: "adjust effect" });
    const targets = env.requireMany(input.elementIds);
    targets.forEach(requireTarget);
    env.editor.execute(batch("Colour adjust", targets.flatMap((t) => commandsFor(env, t, values, input.reset === true))));
    const applied = targets.map((t) => ({ elementId: t.element.id, params: currentAdjust(env, t.element.id) }));
    return ok(`Adjusted colour on ${applied.length} clip(s).`, { clips: applied });
  },
});

const applyFilter = defineTool<{ elementIds: string[]; filter: FilterPresetId | "none"; intensity?: number }>({
  name: "apply_filter",
  description: `Give clips a named look. filter: ${FILTER_PRESET_IDS.map((id) => `${id} (${FILTER_PRESETS[id].name})`).join(", ")} or "none" to clear the look. A filter is a bundle of adjust parameters: it replaces the clip's earlier adjust values (not other effects like blur) and stays editable with set_color_adjust. \`intensity\` 0-1 (default 1) scales the look. All clips change as one undo step.`,
  inputSchema: {
    type: "object",
    properties: {
      elementIds: ELEMENT_IDS,
      filter: { type: "string", enum: [...FILTER_PRESET_IDS, "none"] },
      intensity: { type: "number", minimum: 0, maximum: 1 },
    },
    required: ["elementIds", "filter"],
  },
  readOnly: false,
  run(input, env) {
    env.requireProject();
    if (input.elementIds.length === 0) throw new ToolError("elementIds is empty.", "Pass at least one clip id.");
    const targets = env.requireMany(input.elementIds);
    targets.forEach(requireTarget);
    const intensity = input.intensity ?? 1;
    if (input.filter === "none") {
      const commands: Command[] = targets.flatMap((t) => {
        const existing = adjustEffectOf(t.element);
        if (t.element.type === "effect") return commandsFor(env, t, {}, true);
        return existing ? [removeClipEffect(t.ref, existing.id)] : [];
      });
      if (commands.length === 0) throw new ToolError("None of those clips has a filter or colour adjustment.", "Nothing to clear.");
      env.editor.execute(batch("Clear filter", commands));
      return ok(`Cleared the look on ${commands.length} clip(s).`, { elementIds: input.elementIds });
    }
    const preset = FILTER_PRESETS[input.filter];
    const scaled: ParamValues = {};
    for (const [key, value] of Object.entries(preset.params)) scaled[key] = Math.round(value * intensity);
    env.editor.execute(batch(`Filter: ${preset.name}`, targets.flatMap((t) => commandsFor(env, t, scaled, true))));
    return ok(`Applied the ${preset.name} filter to ${targets.length} clip(s).`, {
      filter: input.filter, intensity, params: scaled, elementIds: targets.map((t) => t.element.id),
    });
  },
});

export const COLOR_TOOLS: AgentTool[] = [setColorAdjust, applyFilter];
