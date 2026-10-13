import { setCursorPathCommand } from "#/engine/commands";
import { CURSOR_STYLES, GRAPHIC_DEFINITIONS, buildGraphicElement, defaultsOf, type TimelineElement } from "#/engine/model";
import { MAX_CURSOR_WAYPOINTS, type CursorWaypoint } from "#/engine/animation";
import { TICKS_PER_SECOND, mediaTime } from "#/engine/time";
import { defineTool, ok, toSec, ToolError, type ToolEnv } from "./env";
import { PLACEMENT_PROPS, place } from "./tools-insert";
import { paramSpecsFor, validateParamValues } from "./params";
import type { AgentTool, JsonSchema } from "./types";

interface PointInput { time: number; x: number; y: number; click?: boolean }

const POINTS_SCHEMA: JsonSchema = {
  type: "array",
  description: `Stops in time order (1 to ${MAX_CURSOR_WAYPOINTS}): { time (SECONDS from the start of the cursor clip), x, y (px from the canvas centre, +y is down), click? }. The cursor eases from stop to stop; two stops at one place make it wait; click:true plays the ripple.`,
  items: {
    type: "object",
    properties: { time: { type: "number", minimum: 0 }, x: { type: "number" }, y: { type: "number" }, click: { type: "boolean" } },
    required: ["time", "x", "y"],
  },
};

function waypointsOf(env: ToolEnv, points: ReadonlyArray<PointInput>): CursorWaypoint[] {
  if (!Array.isArray(points) || points.length === 0) throw new ToolError("points is empty.", "Pass at least one stop { time, x, y }.");
  if (points.length > MAX_CURSOR_WAYPOINTS) throw new ToolError(`${points.length} stops is too many.`, `Use at most ${MAX_CURSOR_WAYPOINTS} stops.`);
  return points.map((p, i) => {
    if (typeof p !== "object" || p === null || ![p.time, p.x, p.y].every((v) => typeof v === "number" && Number.isFinite(v))) {
      throw new ToolError(`Point ${i + 1} needs numeric time, x and y.`, "Each stop is { time (seconds), x, y (px from the canvas centre), click? }.");
    }
    return { time: env.snapTicks(Math.round(p.time * TICKS_PER_SECOND)), x: p.x, y: p.y, ...(p.click === true ? { click: true } : {}) };
  });
}

const insertCursor = defineTool<{
  points: PointInput[]; start?: number; duration?: number; trackId?: string; newTrack?: boolean; params?: Record<string, unknown>;
}>({
  name: "insert_cursor",
  description:
    `Add an animated mouse cursor on top of the picture and move it through \`points\`. The cursor's tip is at its position. \`params\`: style (${CURSOR_STYLES.join("|")}), fill, stroke, rippleColor (#rrggbb), plus transform.scaleX/scaleY to size it (scale 1 is a 1080 px box; about 0.45 gives a normal pointer). Without \`duration\` it lasts until the last stop plus one second. Use set_cursor_path to re-route it later.`,
  inputSchema: {
    type: "object",
    properties: {
      points: POINTS_SCHEMA,
      start: PLACEMENT_PROPS.start as JsonSchema,
      duration: { type: "number", minimum: 0.1, description: "Length in SECONDS." },
      trackId: PLACEMENT_PROPS.trackId as JsonSchema,
      newTrack: PLACEMENT_PROPS.newTrack as JsonSchema,
      params: { type: "object", description: "Cursor param key -> value." },
    },
    required: ["points"],
  },
  readOnly: false,
  run(input, env) {
    env.requireProject();
    const definition = GRAPHIC_DEFINITIONS["cursor"];
    if (!definition) throw new ToolError("The cursor graphic is unavailable.", "Use insert_graphic with another shape.");
    const waypoints = waypointsOf(env, input.points);
    const last = waypoints[waypoints.length - 1] as CursorWaypoint;
    const duration = input.duration === undefined ? mediaTime(last.time + TICKS_PER_SECOND) : env.snapDuration(input.duration);
    const base = buildGraphicElement({ id: env.editor.newId(), startTime: mediaTime(0), definitionId: definition.id, name: definition.name, params: defaultsOf(definition.params) });
    const sized = { ...base, duration, params: { ...base.params, "transform.scaleX": 0.45, "transform.scaleY": 0.45 } } as TimelineElement;
    const extra = input.params ? validateParamValues({ specs: paramSpecsFor(sized), values: input.params, subject: "cursor" }) : {};
    const element = { ...sized, params: { ...sized.params, ...extra } } as TimelineElement;
    const problem = waypoints.find((w) => w.time > duration);
    if (problem) throw new ToolError(`A stop at ${toSec(problem.time)}s is beyond the cursor clip (${toSec(duration)}s).`, "Raise duration or move the stop earlier.");
    const result = place(env, { element, start: input.start === undefined ? undefined : env.snap(input.start), trackId: input.trackId, newTrack: input.newTrack }, "cursor");
    if (!result.ok) return result;
    const elementId = (result.data as { elementId: string }).elementId;
    env.editor.execute(setCursorPathCommand({ ref: env.require(elementId).ref, waypoints }));
    return result;
  },
});

const setCursorPath = defineTool<{ elementId: string; points: PointInput[] }>({
  name: "set_cursor_path",
  description: "Re-route an existing cursor clip through new `points` (same shape as insert_cursor). Replaces its keyframes on position and click; its look is untouched.",
  inputSchema: { type: "object", properties: { elementId: { type: "string", description: "A cursor clip id from get_timeline." }, points: POINTS_SCHEMA }, required: ["elementId", "points"] },
  readOnly: false,
  run(input, env) {
    env.requireProject();
    const target = env.require(input.elementId);
    if (target.element.type !== "graphic" || target.element.definitionId !== "cursor") {
      throw new ToolError(`"${input.elementId}" is not a cursor clip.`, "Pick a clip made by insert_cursor, or create one with insert_cursor.");
    }
    const waypoints = waypointsOf(env, input.points);
    env.editor.execute(setCursorPathCommand({ ref: target.ref, waypoints }));
    return ok(`Moved the cursor through ${waypoints.length} stop(s).`, { elementId: input.elementId, stops: waypoints.length, clicks: waypoints.filter((w) => w.click).length });
  },
});

export const CURSOR_TOOLS: AgentTool[] = [insertCursor, setCursorPath];
