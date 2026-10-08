import { batch, updateElements, upsertKeyframeCommand, type Command } from "#/engine/commands";
import type { ElementRef, ParamValue, ParamValues, TimelineElement } from "#/engine/model";

/** Path used for animating a parameter: graphics namespace their own params; everything else uses the key. */
export function animationPathFor(element: TimelineElement, key: string): string {
  if (element.type === "graphic" && !key.startsWith("transform.") && key !== "opacity" && key !== "blendMode") return `params.${key}`;
  return key;
}

export function keyOfPath(path: string): string {
  return path.startsWith("params.") ? path.slice("params.".length) : path;
}

/**
 * Edits parameters the way the inspector and canvas handles do: a parameter that already has keyframes gets a
 * keyframe at the playhead (when it is inside the clip); otherwise the static value changes.
 */
export function paramEditCommand(input: {
  element: TimelineElement; ref: ElementRef; values: ParamValues; playhead: number; label?: string;
}): Command {
  const { element, ref } = input;
  const local = input.playhead - element.startTime;
  const inRange = local >= 0 && local <= element.duration;
  const statics: ParamValues = {};
  const commands: Command[] = [];
  for (const [key, value] of Object.entries(input.values) as Array<[string, ParamValue]>) {
    const path = animationPathFor(element, key);
    if (inRange && element.animations?.[path]) commands.push(upsertKeyframeCommand({ ref, path, time: Math.round(local), value }));
    else statics[key] = value;
  }
  if (Object.keys(statics).length > 0) commands.unshift(updateElements([{ ref, patch: { params: statics } }], input.label ?? "Edit properties"));
  return commands.length === 1 ? (commands[0] as Command) : batch(input.label ?? "Edit properties", commands);
}
