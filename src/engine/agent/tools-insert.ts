import { insertElement, type InsertPlacement } from "#/engine/commands";
import {
  EFFECT_DEFINITIONS, GRAPHIC_DEFINITIONS, LAYER_EFFECT_TYPES, PARAM, buildEffectElement, buildGraphicElement, buildMediaElement, buildTextElement,
  defaultsOf, orderedTracks, type ParamValues, type TimelineElement,
} from "#/engine/model";
import { canPlaceSpans, defaultInsertIndex, elementEnd, highestInsertIndex, trackTypeForElement } from "#/engine/timeline";
import { mediaTime, type MediaTime } from "#/engine/time";
import { defineTool, ok, toSec, ToolError, type ToolEnv } from "./env";
import { paramSpecsFor, textSpecs, validateParamValues } from "./params";
import type { AgentTool, JsonSchema } from "./types";

export const PLACEMENT_PROPS: Record<string, JsonSchema> = {
  start: { type: "number", minimum: 0, description: "Timeline position in SECONDS (snapped to the frame grid)." },
  trackId: { type: "string", description: "Existing track to place on; its kind must match. Fails if the span is occupied." },
  newTrack: { type: "boolean", description: "Create a new track for this element (above the main track for visual kinds)." },
};

interface PlacementInput {
  trackId?: string;
  newTrack?: boolean;
}

function mainEnd(env: ToolEnv): MediaTime {
  return mediaTime(env.tracks.main.elements.reduce((end, e) => Math.max(end, elementEnd(e)), 0));
}

function audioEnd(env: ToolEnv): MediaTime {
  const first = env.tracks.audio[0];
  return mediaTime(first ? first.elements.reduce((end, e) => Math.max(end, elementEnd(e)), 0) : 0);
}

/** Where an element goes when the agent gave no start: media appends, layers land on the playhead. */
function defaultStart(env: ToolEnv, element: TimelineElement, trackId: string | undefined): MediaTime {
  if (trackId) {
    const track = env.requireTrack(trackId);
    if (element.type === "video" || element.type === "image" || element.type === "audio") {
      return mediaTime((track.elements as TimelineElement[]).reduce((end, e) => Math.max(end, elementEnd(e)), 0));
    }
    return env.playhead;
  }
  if (element.type === "video" || element.type === "image") return mainEnd(env);
  if (element.type === "audio") return audioEnd(env);
  return env.playhead;
}

function choosePlacement(env: ToolEnv, element: TimelineElement, input: PlacementInput): InsertPlacement {
  const trackType = trackTypeForElement(element.type);
  const span = [{ start: element.startTime, duration: element.duration }];
  if (input.trackId !== undefined && input.newTrack) {
    throw new ToolError("Pass either trackId or newTrack, not both.", "Use trackId to reuse a track, newTrack:true to create one.");
  }
  if (input.newTrack) {
    const index = trackType === "audio" ? defaultInsertIndex(env.tracks, trackType) : highestInsertIndex(env.tracks, trackType);
    return { mode: "newTrack", index };
  }
  if (input.trackId !== undefined) {
    const track = env.requireTrack(input.trackId);
    if (track.type !== trackType) {
      const compatible = orderedTracks(env.tracks).filter((t) => t.type === trackType).map((t) => t.id);
      throw new ToolError(
        `Track "${track.id}" is a ${track.type} track and cannot hold a ${element.type}.`,
        compatible.length > 0 ? `Use one of the ${trackType} tracks: ${compatible.join(", ")}, or pass newTrack:true.` : `There is no ${trackType} track yet; pass newTrack:true.`,
      );
    }
    if (!canPlaceSpans(track, span)) {
      throw new ToolError(
        `Track "${track.id}" is occupied between ${toSec(element.startTime)}s and ${toSec(element.startTime + element.duration)}s.`,
        "Pick a free start (see `gaps` in get_timeline), another trackId, or newTrack:true.",
      );
    }
    return { mode: "explicit", trackId: track.id };
  }
  if (element.type === "video" || element.type === "image") {
    return canPlaceSpans(env.tracks.main, span) ? { mode: "explicit", trackId: env.tracks.main.id } : { mode: "newTrack", index: highestInsertIndex(env.tracks, trackType) };
  }
  return { mode: "auto" };
}

export function place(env: ToolEnv, input: { element: TimelineElement; start: MediaTime | undefined } & PlacementInput, what: string) {
  env.requireProject();
  const startTime = input.start ?? defaultStart(env, input.element, input.trackId);
  const element = { ...input.element, startTime } as TimelineElement;
  const placement = choosePlacement(env, element, input);
  const tracksBefore = new Set(orderedTracks(env.tracks).map((t) => t.id));
  env.editor.execute(insertElement({ element, placement }));
  const located = env.locate(element.id);
  if (!located) throw new ToolError(`The ${what} could not be placed.`, "Call get_timeline and retry with a different start or newTrack:true.");
  const placed = located.element;
  const data = {
    elementId: placed.id,
    trackId: located.track.id,
    trackCreated: !tracksBefore.has(located.track.id),
    start: toSec(placed.startTime),
    end: toSec(elementEnd(placed)),
    duration: toSec(placed.duration),
  };
  const adjusted = input.start !== undefined && placed.startTime !== input.start ? ` (start adjusted to ${data.start}s)` : "";
  return ok(`Inserted ${what} ${data.elementId} on track ${data.trackId} from ${data.start}s to ${data.end}s${adjusted}.`, data);
}

const insertMedia = defineTool<PlacementInput & { assetId: string; start?: number; duration?: number }>({
  name: "insert_media",
  description:
    "Insert a video, audio or image asset (see list_assets). Times are SECONDS, snapped to the frame grid. Without `start`, video/image append after the last clip on the main track and audio appends to the first audio track. Without trackId/newTrack, video/image use the main track if free, else a new overlay track; audio uses the first free audio track. The main track pins its first clip to 0. Returns elementId, trackId, final start/end in seconds.",
  inputSchema: {
    type: "object",
    properties: {
      assetId: { type: "string", description: "Asset id from list_assets." },
      ...PLACEMENT_PROPS,
      duration: { type: "number", minimum: 0.001, description: "Images only: display length in SECONDS (default 5)." },
    },
    required: ["assetId"],
  },
  readOnly: false,
  run(input, env) {
    env.requireProject();
    const asset = env.editor.getAsset(input.assetId);
    if (!asset) {
      const known = env.doc.assets.map((a) => a.id).join(", ") || "(no assets imported)";
      throw new ToolError(`No asset with id "${input.assetId}".`, `Call list_assets. Known ids: ${known}.`);
    }
    if (input.duration !== undefined && asset.type !== "image") {
      throw new ToolError("duration only applies to images.", "Videos and audio use their source length; use trim to shorten them after inserting.");
    }
    let element = buildMediaElement({ id: env.editor.newId(), startTime: mediaTime(0), asset });
    if (input.duration !== undefined) element = { ...element, duration: env.snapDuration(input.duration) };
    return place(env, { element, start: input.start === undefined ? undefined : env.snap(input.start), trackId: input.trackId, newTrack: input.newTrack }, asset.type);
  },
});

const STYLE_TO_PARAM: Record<string, string> = {
  fontSize: PARAM.fontSize,
  fontFamily: PARAM.fontFamily,
  color: PARAM.color,
  textAlign: PARAM.textAlign,
  fontWeight: PARAM.fontWeight,
  fontStyle: PARAM.fontStyle,
  textDecoration: PARAM.textDecoration,
  letterSpacing: PARAM.letterSpacing,
  lineHeight: PARAM.lineHeight,
  opacity: PARAM.opacity,
  positionX: PARAM.positionX,
  positionY: PARAM.positionY,
};

const insertText = defineTool<PlacementInput & {
  text: string; start?: number; duration?: number; style?: Record<string, unknown>;
}>({
  name: "insert_text",
  description:
    "Add a text clip. `start` and `duration` are SECONDS (default: playhead, 5s; snapped to frames). `style` keys: fontSize (relative to a 90-unit-tall canvas, default 15), fontFamily, color (#rrggbb), textAlign, fontWeight (normal|bold), fontStyle, textDecoration, letterSpacing, lineHeight, opacity, positionX/positionY (px from canvas center, +y down), backgroundColor (#rrggbb; turns the text background on). Uses the first free text track or creates one. Returns elementId, trackId, start/end in seconds.",
  inputSchema: {
    type: "object",
    properties: {
      text: { type: "string", description: "The text to display." },
      start: PLACEMENT_PROPS.start as JsonSchema,
      duration: { type: "number", minimum: 0.001, description: "Length in SECONDS (default 5)." },
      trackId: PLACEMENT_PROPS.trackId as JsonSchema,
      newTrack: PLACEMENT_PROPS.newTrack as JsonSchema,
      style: {
        type: "object",
        description: "Optional look; see tool description for keys.",
        properties: {
          fontSize: { type: "number" }, fontFamily: { type: "string" }, color: { type: "string" },
          textAlign: { type: "string", enum: ["left", "center", "right"] },
          fontWeight: { type: "string", enum: ["normal", "bold"] },
          fontStyle: { type: "string", enum: ["normal", "italic"] },
          textDecoration: { type: "string", enum: ["none", "underline", "line-through"] },
          letterSpacing: { type: "number" }, lineHeight: { type: "number" }, opacity: { type: "number" },
          positionX: { type: "number" }, positionY: { type: "number" }, backgroundColor: { type: "string" },
        },
      },
    },
    required: ["text"],
  },
  readOnly: false,
  run(input, env) {
    env.requireProject();
    if (input.text.length === 0) throw new ToolError("text is empty.", "Provide the words to show.");
    const base = buildTextElement({
      id: env.editor.newId(), startTime: mediaTime(0), content: input.text,
      duration: input.duration === undefined ? undefined : env.snapDuration(input.duration),
    });
    let element = base;
    if (input.style) {
      const { backgroundColor, ...rest } = input.style;
      const raw: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(rest)) raw[STYLE_TO_PARAM[key] ?? key] = value;
      if (backgroundColor !== undefined) {
        raw[PARAM.bgEnabled] = true;
        raw[PARAM.bgColor] = backgroundColor;
      }
      if (Object.keys(raw).length > 0) {
        const params = validateParamValues({ specs: textSpecs(), values: raw, subject: "text style" });
        element = { ...base, params: { ...base.params, ...params } };
      }
    }
    return place(env, { element, start: input.start === undefined ? undefined : env.snap(input.start), trackId: input.trackId, newTrack: input.newTrack }, "text");
  },
});

const insertGraphic = defineTool<PlacementInput & {
  shape: string; start?: number; duration?: number; params?: Record<string, unknown>;
}>({
  name: "insert_graphic",
  description:
    "Add a vector shape clip. `shape` is rectangle|ellipse|polygon|star. `start`/`duration` in SECONDS (default: playhead, 5s). `params` uses the real param keys, e.g. fill/stroke (#rrggbb), strokeWidth, cornerRadius, sides, points, depth, plus transform.positionX/positionY (px from canvas center), transform.scaleX/scaleY, transform.rotate (degrees), opacity. Invalid keys list the valid ones.",
  inputSchema: {
    type: "object",
    properties: {
      shape: { type: "string", enum: Object.keys(GRAPHIC_DEFINITIONS) },
      start: PLACEMENT_PROPS.start as JsonSchema,
      duration: { type: "number", minimum: 0.001, description: "Length in SECONDS (default 5)." },
      trackId: PLACEMENT_PROPS.trackId as JsonSchema,
      newTrack: PLACEMENT_PROPS.newTrack as JsonSchema,
      params: { type: "object", description: "Param key -> value." },
    },
    required: ["shape"],
  },
  readOnly: false,
  run(input, env) {
    env.requireProject();
    const definition = GRAPHIC_DEFINITIONS[input.shape];
    if (!definition) throw new ToolError(`Unknown shape "${input.shape}".`, `Use one of: ${Object.keys(GRAPHIC_DEFINITIONS).join(", ")}.`);
    const base = buildGraphicElement({
      id: env.editor.newId(), startTime: mediaTime(0), definitionId: definition.id, name: definition.name, params: defaultsOf(definition.params),
    });
    const element = { ...base, duration: input.duration === undefined ? base.duration : env.snapDuration(input.duration) };
    const params: ParamValues = input.params
      ? validateParamValues({ specs: paramSpecsFor(element), values: input.params, subject: `${definition.id} graphic` })
      : {};
    return place(env, { element: { ...element, params: { ...element.params, ...params } }, start: input.start === undefined ? undefined : env.snap(input.start), trackId: input.trackId, newTrack: input.newTrack }, `${definition.id} graphic`);
  },
});

const insertEffectLayer = defineTool<PlacementInput & {
  effectType: string; start?: number; duration?: number; params?: Record<string, unknown>;
}>({
  name: "insert_effect_layer",
  description:
    "Add a scene-wide effect layer (e.g. blur) that applies to everything drawn beneath it for its duration. `start`/`duration` in SECONDS (default: playhead, 5s). `params` uses the effect's real keys (blur: intensity 0..100). To affect a single clip use add_effect instead.",
  inputSchema: {
    type: "object",
    properties: {
      effectType: { type: "string", enum: [...LAYER_EFFECT_TYPES] },
      start: PLACEMENT_PROPS.start as JsonSchema,
      duration: { type: "number", minimum: 0.001, description: "Length in SECONDS (default 5)." },
      trackId: PLACEMENT_PROPS.trackId as JsonSchema,
      newTrack: PLACEMENT_PROPS.newTrack as JsonSchema,
      params: { type: "object", description: "Effect param key -> value." },
    },
    required: ["effectType"],
  },
  readOnly: false,
  run(input, env) {
    env.requireProject();
    const definition = EFFECT_DEFINITIONS[input.effectType];
    if (!definition) throw new ToolError(`Unknown effect "${input.effectType}".`, `Use one of: ${LAYER_EFFECT_TYPES.join(", ")}.`);
    if (definition.scope === "clip") throw new ToolError(`${definition.name} works on a single clip, not a scene-wide layer.`, "Use add_effect on a video or image clip.");
    const base = buildEffectElement({
      id: env.editor.newId(), startTime: mediaTime(0), effectType: definition.type, params: defaultsOf(definition.params), name: definition.name,
    });
    const element = { ...base, duration: input.duration === undefined ? base.duration : env.snapDuration(input.duration) };
    const params: ParamValues = input.params
      ? validateParamValues({ specs: paramSpecsFor(element), values: input.params, subject: `${definition.type} effect` })
      : {};
    return place(env, { element: { ...element, params: { ...element.params, ...params } }, start: input.start === undefined ? undefined : env.snap(input.start), trackId: input.trackId, newTrack: input.newTrack }, `${definition.type} effect layer`);
  },
});

export const INSERT_TOOLS: AgentTool[] = [insertMedia, insertText, insertGraphic, insertEffectLayer];
