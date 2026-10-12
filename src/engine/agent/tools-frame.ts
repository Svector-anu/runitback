import { batch, freezeFrameCommand, type Command } from "#/engine/commands";
import { CROP_MAX_EDGE, PARAM, type ParamValues } from "#/engine/model";
import { elementEnd } from "#/engine/timeline";
import { defineTool, ok, toSec, ToolError } from "./env";
import { paramEditCommand, validateParamValues, paramSpecsFor } from "./params";
import type { AgentTool, JsonSchema } from "./types";

const EDGE: JsonSchema = { type: "number", minimum: 0, maximum: CROP_MAX_EDGE };
const DEFAULT_FREEZE_SECONDS = 2;

const setCrop = defineTool<{ elementIds: string[]; left?: number; top?: number; right?: number; bottom?: number; reset?: boolean }>({
  name: "set_crop",
  description:
    `Crop video or image clips by cutting a fraction (0-${CROP_MAX_EDGE}) of the source off each side, applied before position/scale/rotation. The remaining part stays where it was on the canvas, so use set_params transform.scaleX/scaleY to fill the frame afterwards. Only the sides you pass change; \`reset\` clears all four first. Opposite sides may not remove more than ${CROP_MAX_EDGE * 100}% together. One undo step.`,
  inputSchema: {
    type: "object",
    properties: {
      elementIds: { type: "array", items: { type: "string" }, description: "Video or image clip ids." },
      left: EDGE, top: EDGE, right: EDGE, bottom: EDGE,
      reset: { type: "boolean", description: "Set every side to 0 before applying the ones given." },
    },
    required: ["elementIds"],
  },
  readOnly: false,
  run(input, env) {
    env.requireProject();
    if (input.elementIds.length === 0) throw new ToolError("elementIds is empty.", "Pass at least one video or image clip id.");
    const given: Record<string, number> = {
      ...(input.left !== undefined ? { [PARAM.cropLeft]: input.left } : {}),
      ...(input.top !== undefined ? { [PARAM.cropTop]: input.top } : {}),
      ...(input.right !== undefined ? { [PARAM.cropRight]: input.right } : {}),
      ...(input.bottom !== undefined ? { [PARAM.cropBottom]: input.bottom } : {}),
    };
    if (Object.keys(given).length === 0 && !input.reset) throw new ToolError("Nothing to crop.", "Pass left, top, right and/or bottom (fractions), or reset: true.");
    const targets = env.requireMany(input.elementIds);
    for (const t of targets) {
      if (t.element.type !== "video" && t.element.type !== "image") {
        throw new ToolError(`Crop applies to video and image clips, not ${t.element.type} "${t.element.id}".`, "Pick a video or image clip.");
      }
    }
    const planned = targets.map((t) => {
      const base: ParamValues = input.reset ? { [PARAM.cropLeft]: 0, [PARAM.cropTop]: 0, [PARAM.cropRight]: 0, [PARAM.cropBottom]: 0 } : {};
      const values = validateParamValues({ specs: paramSpecsFor(t.element), values: { ...base, ...given }, subject: `clip "${t.element.id}"` });
      const after = (key: string): number => Number(values[key] ?? t.element.params[key] ?? 0);
      for (const [a, b, axis] of [[PARAM.cropLeft, PARAM.cropRight, "horizontally"], [PARAM.cropTop, PARAM.cropBottom, "vertically"]] as const) {
        if (after(a) + after(b) > CROP_MAX_EDGE) {
          throw new ToolError(`Cropping ${axis} would remove ${Math.round((after(a) + after(b)) * 100)}% of "${t.element.id}".`, `Keep opposite sides under ${CROP_MAX_EDGE * 100}% together.`);
        }
      }
      return { t, values, ...paramEditCommand({ element: t.element, ref: t.ref, values, playhead: env.playhead, label: "Crop" }) };
    });
    env.editor.execute(batch("Crop", planned.map((p): Command => p.command)));
    return ok(`Cropped ${planned.length} clip(s).`, { clips: planned.map((p) => ({ elementId: p.t.element.id, applied: p.values })) });
  },
});

const freezeFrame = defineTool<{ elementId: string; at?: number; duration?: number }>({
  name: "freeze_frame",
  description:
    `Hold one frame of a video clip: the clip is cut at \`at\` (SECONDS on the timeline, default the playhead; must be inside the clip) and a still of that frame is inserted for \`duration\` SECONDS (default ${DEFAULT_FREEZE_SECONDS}). Everything after \`at\` on the same track moves later by \`duration\`; clips on other tracks do not move. The still is a separate image-like clip (returned as freezeId) that keeps the clip's position, scale, crop, effects and masks. One undo step.`,
  inputSchema: {
    type: "object",
    properties: {
      elementId: { type: "string", description: "A video clip." },
      at: { type: "number", minimum: 0, description: "Timeline SECONDS." },
      duration: { type: "number", minimum: 0.04, description: "SECONDS the still stays on screen." },
    },
    required: ["elementId"],
  },
  readOnly: false,
  run(input, env) {
    env.requireProject();
    const located = env.require(input.elementId);
    if (located.element.type !== "video") {
      throw new ToolError(`A freeze frame needs a video clip, "${input.elementId}" is ${located.element.type}.`, "Pick a video clip.");
    }
    const at = input.at === undefined ? env.playhead : env.snap(input.at);
    if (at < located.element.startTime || at >= elementEnd(located.element)) {
      throw new ToolError(
        `${toSec(at)}s is outside "${input.elementId}" (${toSec(located.element.startTime)}s-${toSec(elementEnd(located.element))}s).`,
        "Pass `at` inside the clip, or move the playhead onto it.",
      );
    }
    const duration = env.snapDuration(input.duration ?? DEFAULT_FREEZE_SECONDS);
    const freezeId = env.editor.newId();
    env.editor.execute(freezeFrameCommand({ ref: located.ref, at, duration, elementId: freezeId }));
    return ok(`Froze the frame at ${toSec(at)}s for ${toSec(duration)}s; later clips on the track moved ${toSec(duration)}s.`, {
      freezeId, at: toSec(at), duration: toSec(duration), end: toSec(at + duration),
    });
  },
});

export const FRAME_TOOLS: AgentTool[] = [setCrop, freezeFrame];
