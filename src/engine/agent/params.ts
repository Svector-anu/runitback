import { batch, updateElements, upsertKeyframeCommand, type Command } from "#/engine/commands";
import {
  BLEND_MODES, CROP_MAX_EDGE, EFFECT_DEFINITIONS, GRAPHIC_DEFINITIONS, MASK_DEFINITIONS, PARAM, VOLUME_DB_MAX, VOLUME_DB_MIN,
  type ElementRef, type MaskType, type ParamDef, type ParamValue, type ParamValues, type TimelineElement,
} from "#/engine/model";
import { COUNT_FORMATS } from "#/engine/render";
import { ToolError } from "./env";
import { didYouMean } from "./validate";

export interface ParamSpec {
  key: string;
  kind: "number" | "boolean" | "string" | "color" | "enum";
  min?: number;
  max?: number;
  options?: ReadonlyArray<string>;
  unit?: string;
}

const HEX_COLOR = /^#(?:[0-9a-f]{6}|[0-9a-f]{8})$/i;

const num = (key: string, extra: Partial<ParamSpec> = {}): ParamSpec => ({ key, kind: "number", ...extra });
const str = (key: string): ParamSpec => ({ key, kind: "string" });
const bool = (key: string): ParamSpec => ({ key, kind: "boolean" });
const color = (key: string): ParamSpec => ({ key, kind: "color" });
const choice = (key: string, options: ReadonlyArray<string>): ParamSpec => ({ key, kind: "enum", options });

const TRANSFORM_SPECS: ParamSpec[] = [
  num(PARAM.positionX, { unit: "px from canvas center" }),
  num(PARAM.positionY, { unit: "px from canvas center, +y is down" }),
  num(PARAM.scaleX, { min: 0 }),
  num(PARAM.scaleY, { min: 0 }),
  num(PARAM.rotate, { unit: "degrees" }),
  num(PARAM.opacity, { min: 0, max: 1 }),
  choice(PARAM.blendMode, BLEND_MODES),
];

const CROP_SPECS: ParamSpec[] = [
  num(PARAM.cropLeft, { min: 0, max: CROP_MAX_EDGE, unit: "fraction of the source cut from the left" }),
  num(PARAM.cropTop, { min: 0, max: CROP_MAX_EDGE, unit: "fraction cut from the top" }),
  num(PARAM.cropRight, { min: 0, max: CROP_MAX_EDGE, unit: "fraction cut from the right" }),
  num(PARAM.cropBottom, { min: 0, max: CROP_MAX_EDGE, unit: "fraction cut from the bottom" }),
];

const AUDIO_SPECS: ParamSpec[] = [
  num(PARAM.volume, { min: VOLUME_DB_MIN, max: VOLUME_DB_MAX, unit: "dB, 0 = unchanged" }),
  bool(PARAM.muted),
  num(PARAM.denoise, { min: 0, max: 1, unit: "noise removal strength, 0 = off (see reduce_noise)" }),
];

const TEXT_SPECS: ParamSpec[] = [
  str(PARAM.content),
  num(PARAM.fontSize, { min: 0.5, max: 200, unit: "relative to a 90-unit-tall canvas" }),
  str(PARAM.fontFamily),
  color(PARAM.color),
  choice(PARAM.textAlign, ["left", "center", "right"]),
  choice(PARAM.fontWeight, ["normal", "bold"]),
  choice(PARAM.fontStyle, ["normal", "italic"]),
  choice(PARAM.textDecoration, ["none", "underline", "line-through"]),
  num(PARAM.letterSpacing),
  num(PARAM.lineHeight, { min: 0.1, max: 10 }),
  bool(PARAM.bgEnabled),
  color(PARAM.bgColor),
  num(PARAM.bgCornerRadius, { min: 0 }),
  num(PARAM.bgPaddingX, { min: 0 }),
  num(PARAM.bgPaddingY, { min: 0 }),
  num(PARAM.bgOffsetX),
  num(PARAM.bgOffsetY),
  num(PARAM.strokeWidth, { min: 0, max: 200, unit: "px at font size 15, scales with size" }),
  color(PARAM.strokeColor),
  bool(PARAM.shadowEnabled),
  color(PARAM.shadowColor),
  num(PARAM.shadowBlur, { min: 0, max: 200 }),
  num(PARAM.shadowOffsetX, { min: -1000, max: 1000 }),
  num(PARAM.shadowOffsetY, { min: -1000, max: 1000 }),
  num(PARAM.reveal, { min: 0, max: 1, unit: "fraction of characters shown" }),
  num(PARAM.blur, { min: 0, max: 100, unit: "text blur strength, 0 = sharp" }),
  num(PARAM.wordReveal, { min: 0, max: 1, unit: "per-word stagger progress: words enter one after another as it rises to 1" }),
  bool(PARAM.caret),
  num(PARAM.highlightWord, { min: -1, max: 100000, unit: "index of the word drawn in highlightColor, counted from 0 across lines; -1 = none" }),
  color(PARAM.highlightColor),
  bool(PARAM.highlightSweep),
  bool(PARAM.countEnabled),
  num(PARAM.countValue, { min: -1e12, max: 1e12, unit: "the number shown when countEnabled; animate it to count up" }),
  choice(PARAM.countFormat, COUNT_FORMATS),
  num(PARAM.countDecimals, { min: 0, max: 6 }),
  str(PARAM.countPrefix),
  str(PARAM.countSuffix),
];

export function specFromDef(def: ParamDef): ParamSpec {
  switch (def.type) {
    case "number": return { key: def.key, kind: "number", min: def.min, max: def.max, unit: def.unit };
    case "boolean": return { key: def.key, kind: "boolean" };
    case "color": return { key: def.key, kind: "color" };
    case "select": return { key: def.key, kind: "enum", options: def.options.map((o) => o.value) };
  }
}

export function effectSpecs(effectType: string): ParamSpec[] {
  return (EFFECT_DEFINITIONS[effectType]?.params ?? []).map(specFromDef);
}

export function maskSpecs(maskType: MaskType): ParamSpec[] {
  return MASK_DEFINITIONS[maskType].params.map(specFromDef);
}

export function graphicSpecs(definitionId: string): ParamSpec[] {
  return (GRAPHIC_DEFINITIONS[definitionId]?.params ?? []).map(specFromDef);
}

export function textSpecs(): ParamSpec[] {
  return [...TRANSFORM_SPECS, ...TEXT_SPECS];
}

/** Every param key an agent may set on this element, with its type and range. */
export function paramSpecsFor(element: TimelineElement): ParamSpec[] {
  switch (element.type) {
    case "video": return [...TRANSFORM_SPECS, ...CROP_SPECS, ...AUDIO_SPECS];
    case "image": return [...TRANSFORM_SPECS, ...CROP_SPECS];
    case "audio": return [...AUDIO_SPECS];
    case "text": return textSpecs();
    case "graphic": return [...TRANSFORM_SPECS, ...graphicSpecs(element.definitionId)];
    case "effect": return effectSpecs(element.effectType);
  }
}

export function describeSpec(spec: ParamSpec): string {
  switch (spec.kind) {
    case "number": {
      const range = spec.min !== undefined || spec.max !== undefined ? ` ${spec.min ?? "-inf"}..${spec.max ?? "inf"}` : "";
      return `${spec.key} (number${range}${spec.unit ? `, ${spec.unit}` : ""})`;
    }
    case "enum": return `${spec.key} (one of ${spec.options?.join("|")})`;
    case "color": return `${spec.key} (hex color like #ff8800)`;
    default: return `${spec.key} (${spec.kind})`;
  }
}

export function specList(specs: ReadonlyArray<ParamSpec>): string {
  return specs.map(describeSpec).join("; ");
}

function checkValue(spec: ParamSpec, value: unknown, subject: string): ParamValue {
  const bad = (problem: string): ToolError =>
    new ToolError(`Invalid value for ${subject} "${spec.key}": ${problem}.`, `Expected ${describeSpec(spec)}.`);
  switch (spec.kind) {
    case "number": {
      if (typeof value !== "number" || !Number.isFinite(value)) throw bad(`got ${JSON.stringify(value)}, need a number`);
      if (spec.min !== undefined && value < spec.min) throw bad(`${value} is below the minimum ${spec.min}`);
      if (spec.max !== undefined && value > spec.max) throw bad(`${value} is above the maximum ${spec.max}`);
      return value;
    }
    case "boolean":
      if (typeof value !== "boolean") throw bad(`got ${JSON.stringify(value)}, need true or false`);
      return value;
    case "string":
      if (typeof value !== "string") throw bad(`got ${JSON.stringify(value)}, need a string`);
      return value;
    case "color":
      if (typeof value !== "string" || !HEX_COLOR.test(value)) throw bad(`got ${JSON.stringify(value)}, need #rrggbb or #rrggbbaa`);
      return value;
    case "enum":
      if (typeof value !== "string" || !spec.options?.includes(value)) throw bad(`got ${JSON.stringify(value)}`);
      return value;
  }
}

/** Validates `values` against `specs`; unknown keys fail with the list of valid keys and a spelling suggestion. */
export function validateParamValues(input: {
  specs: ReadonlyArray<ParamSpec>; values: Record<string, unknown>; subject: string;
}): ParamValues {
  const out: ParamValues = {};
  const keys = input.specs.map((s) => s.key);
  for (const [key, value] of Object.entries(input.values)) {
    const spec = input.specs.find((s) => s.key === key);
    if (!spec) {
      const near = didYouMean(key, keys);
      throw new ToolError(
        `"${key}" is not a valid parameter for ${input.subject}.`,
        `${near ? `Did you mean "${near}"? ` : ""}Valid keys: ${specList(input.specs)}.`,
      );
    }
    out[key] = checkValue(spec, value, input.subject);
  }
  if (Object.keys(out).length === 0) {
    throw new ToolError("params is empty.", `Pass at least one key. Valid keys: ${specList(input.specs)}.`);
  }
  return out;
}

/** Path used to animate a parameter: graphics namespace their own params; everything else uses the key. */
export function animationPathFor(element: TimelineElement, key: string): string {
  if (element.type === "graphic" && !key.startsWith("transform.") && key !== "opacity" && key !== "blendMode") return `params.${key}`;
  return key;
}

/**
 * Engine port of the inspector's parameter edit (app/param-edit.ts): a parameter that already has keyframes gets a
 * keyframe at the playhead (when it is inside the clip); otherwise the static value changes.
 */
export function paramEditCommand(input: {
  element: TimelineElement; ref: ElementRef; values: ParamValues; playhead: number; label?: string;
}): { command: Command; keyframed: string[] } {
  const { element, ref } = input;
  const label = input.label ?? "Edit properties";
  const local = input.playhead - element.startTime;
  const inRange = local >= 0 && local <= element.duration;
  const statics: ParamValues = {};
  const keyframed: string[] = [];
  const commands: Command[] = [];
  for (const [key, value] of Object.entries(input.values)) {
    const path = animationPathFor(element, key);
    if (inRange && element.animations?.[path]) {
      commands.push(upsertKeyframeCommand({ ref, path, time: Math.round(local), value }));
      keyframed.push(key);
    } else {
      statics[key] = value;
    }
  }
  if (Object.keys(statics).length > 0) commands.unshift(updateElements([{ ref, patch: { params: statics } }], label));
  return { command: commands.length === 1 ? (commands[0] as Command) : batch(label, commands), keyframed };
}
