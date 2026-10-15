import { autoZoomCommand } from "#/engine/commands";
import { AUTO_ZOOM_MAX_SCALE, AUTO_ZOOM_MIN_SCALE, MAX_AUTO_ZOOMS, autoZoomProblem, type AutoZoom } from "#/engine/animation";
import { TICKS_PER_SECOND } from "#/engine/time";
import { defineTool, ok, ToolError } from "./env";
import type { AgentTool, JsonSchema } from "./types";

interface ZoomInput { at: number; x: number; y: number; scale?: number; in?: number; hold?: number; out?: number }

const DEFAULT_SCALE = 2;
const DEFAULT_IN_SECONDS = 0.6;
const DEFAULT_HOLD_SECONDS = 1.5;
const DEFAULT_OUT_SECONDS = 0.6;

const ZOOM_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    at: { type: "number", minimum: 0, description: "When the push-in starts, in timeline SECONDS." },
    x: { type: "number", description: "Point to zoom into: canvas pixels from the canvas centre, +x right." },
    y: { type: "number", description: "Canvas pixels from the canvas centre, +y down." },
    scale: { type: "number", minimum: AUTO_ZOOM_MIN_SCALE, maximum: AUTO_ZOOM_MAX_SCALE, description: `How much bigger (default ${DEFAULT_SCALE}).` },
    in: { type: "number", minimum: 0.04, description: `Ease-in length in SECONDS (default ${DEFAULT_IN_SECONDS}).` },
    hold: { type: "number", minimum: 0, description: `Time held zoomed in SECONDS (default ${DEFAULT_HOLD_SECONDS}).` },
    out: { type: "number", minimum: 0, description: `Ease-back length in SECONDS (default ${DEFAULT_OUT_SECONDS}); 0 stays zoomed until the next zoom or the end.` },
  },
  required: ["at", "x", "y"],
};

const autoZoom = defineTool<{ elementId: string; zooms: ZoomInput[] }>({
  name: "auto_zoom",
  description:
    `Push a video, image or graphic clip in on points of its picture, like a screen recording that zooms to what matters. Each zoom eases in to \`scale\` with the chosen point at the centre of the frame, holds, then eases back (or stays, with out 0). Up to ${MAX_AUTO_ZOOMS} zooms, in order and not overlapping, all inside the clip. Written as keyframes on scale and position, replacing any keyframes already on those parameters. Times are in SECONDS on the timeline; x and y are canvas pixels from the centre (0, 0 is the middle of the frame). One undo step.`,
  inputSchema: {
    type: "object",
    properties: { elementId: { type: "string", description: "A video, image or graphic clip id from get_timeline." }, zooms: { type: "array", items: ZOOM_SCHEMA, description: "Push-ins in time order." } },
    required: ["elementId", "zooms"],
  },
  readOnly: false,
  run(input, env) {
    env.requireProject();
    const target = env.require(input.elementId);
    if (target.element.type !== "video" && target.element.type !== "image" && target.element.type !== "graphic") {
      throw new ToolError(`"${input.elementId}" is a ${target.element.type} clip.`, "Auto zoom works on video, image and graphic clips.");
    }
    const startTicks = target.element.startTime;
    const zooms: AutoZoom[] = input.zooms.map((z) => ({
      at: env.snapTicks(Math.round(z.at * TICKS_PER_SECOND)) - startTicks,
      x: z.x, y: z.y, scale: z.scale ?? DEFAULT_SCALE,
      inTicks: env.snapDuration(z.in ?? DEFAULT_IN_SECONDS), holdTicks: env.snap(z.hold ?? DEFAULT_HOLD_SECONDS), outTicks: env.snap(z.out ?? DEFAULT_OUT_SECONDS),
    }));
    const problem = autoZoomProblem({ zooms, clipDuration: target.element.duration });
    if (problem) throw new ToolError(`Cannot zoom: ${problem}.`, "Keep every zoom inside the clip (see its start and end in get_timeline), in order and not overlapping, with a scale of 1.1 to 8.");
    env.editor.execute(autoZoomCommand({ ref: target.ref, zooms }));
    return ok(`Added ${zooms.length} zoom(s) to ${input.elementId}.`, { elementId: input.elementId, zooms: zooms.length });
  },
});

export const ZOOM_TOOLS: AgentTool[] = [autoZoom];
