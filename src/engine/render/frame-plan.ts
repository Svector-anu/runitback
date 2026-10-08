import {
  BLEND_MODES, DEFAULT_GRAPHIC_SOURCE_SIZE, numberParam, stringParam, PARAM, type BlendMode, type CanvasSize,
  type Background, type Effect, type Mask, type MediaAssetInfo, type ParamValues, type SceneTracks, type TimelineElement,
  type TimelineTrack,
} from "#/engine/model";
import { TICKS_PER_SECOND } from "#/engine/time";
import { resolveEffectParams, resolveElementParams, sourceTimeAt } from "#/engine/timeline";

export interface LayerTransform {
  centerX: number;
  centerY: number;
  width: number;
  height: number;
  rotationDegrees: number;
  flipX: boolean;
  flipY: boolean;
}

export interface ResolvedEffect {
  type: string;
  params: ParamValues;
}

export interface ResolvedMask {
  mask: Mask;
  params: ParamValues;
}

export type LayerSource =
  | { type: "video"; mediaId: string; sourceSeconds: number; width: number; height: number }
  | { type: "image"; mediaId: string; width: number; height: number }
  | { type: "graphic"; definitionId: string; params: ParamValues; width: number; height: number };

interface LayerBase {
  elementId: string;
  opacity: number;
  blendMode: BlendMode;
  effects: ResolvedEffect[];
}

export interface MediaLayer extends LayerBase {
  kind: "layer";
  source: LayerSource;
  transform: LayerTransform;
  mask: ResolvedMask | null;
}

export interface TextLayer extends LayerBase {
  kind: "text";
  params: ParamValues;
}

export interface SceneEffectItem {
  kind: "sceneEffect";
  elementId: string;
  effects: ResolvedEffect[];
}

export interface BlurBackgroundItem {
  kind: "blurBackground";
  elementId: string;
  source: Extract<LayerSource, { type: "video" | "image" }>;
  intensity: number;
}

export type DrawItem = MediaLayer | TextLayer | SceneEffectItem | BlurBackgroundItem;

export interface FramePlan {
  width: number;
  height: number;
  time: number;
  /** Solid fill drawn first; blur backgrounds contribute `blurBackground` items instead. */
  backgroundColor: string | null;
  items: DrawItem[];
  /** Elements that could not be drawn (their media is not in the project). */
  missingMedia: string[];
}

export const DEFAULT_BACKGROUND_BLUR_INTENSITY = 10;
export const IMAGE_PREVIEW_MAX = 2048;

const blendModeOf = (value: string): BlendMode => ((BLEND_MODES as readonly string[]).includes(value) ? (value as BlendMode) : "normal");

function isActive(element: TimelineElement, time: number): boolean {
  return element.startTime <= time && time < element.startTime + element.duration;
}

function visibleElements(track: TimelineTrack): TimelineElement[] {
  if ("hidden" in track && track.hidden) return [];
  return (track.elements as TimelineElement[])
    .filter((e) => !("hidden" in e && e.hidden))
    .sort((a, b) => a.startTime - b.startTime || a.id.localeCompare(b.id));
}

/** Bottom-to-top track order: main first, then overlays from the lowest to the topmost. */
export function drawOrder(tracks: SceneTracks): TimelineTrack[] {
  return [tracks.main, ...[...tracks.overlay].reverse()].filter((t) => !t.hidden);
}

export function computeVisualTransform(input: {
  canvas: CanvasSize; sourceWidth: number; sourceHeight: number; params: ParamValues;
}): LayerTransform {
  const { canvas, sourceWidth, sourceHeight, params } = input;
  const contain = Math.min(canvas.width / sourceWidth, canvas.height / sourceHeight);
  const scaleX = numberParam(params, PARAM.scaleX, 1);
  const scaleY = numberParam(params, PARAM.scaleY, 1);
  return {
    centerX: canvas.width / 2 + numberParam(params, PARAM.positionX, 0),
    centerY: canvas.height / 2 + numberParam(params, PARAM.positionY, 0),
    width: Math.abs(sourceWidth * contain * scaleX),
    height: Math.abs(sourceHeight * contain * scaleY),
    rotationDegrees: numberParam(params, PARAM.rotate, 0),
    flipX: scaleX < 0,
    flipY: scaleY < 0,
  };
}

function resolveEffects(element: TimelineElement, localTime: number): ResolvedEffect[] {
  const effects = (element as { effects?: Effect[] }).effects ?? [];
  return effects.filter((e) => e.enabled).map((e) => ({ type: e.type, params: resolveEffectParams(element, e, localTime) }));
}

function activeMask(element: TimelineElement): ResolvedMask | null {
  const mask = (element as { masks?: Mask[] }).masks?.[0];
  return mask ? { mask, params: mask.params } : null;
}

/**
 * Pure description of the frame at `time`: what to draw, in which order, with every animated value resolved.
 * Preview and export both render this plan.
 */
export function buildFramePlan(input: {
  tracks: SceneTracks;
  canvas: CanvasSize;
  background: Background;
  assets: ReadonlyArray<MediaAssetInfo>;
  time: number;
}): FramePlan {
  const { tracks, canvas, time } = input;
  const assets = new Map(input.assets.map((a) => [a.id, a]));
  const items: DrawItem[] = [];
  const missing: string[] = [];
  const blurBackgrounds: BlurBackgroundItem[] = [];

  for (const track of drawOrder(tracks)) {
    for (const element of visibleElements(track)) {
      if (!isActive(element, time)) continue;
      const clipTime = time - element.startTime;
      const params = resolveElementParams(element, clipTime);
      const opacity = numberParam(params, PARAM.opacity, 1);
      const blendMode = blendModeOf(stringParam(params, PARAM.blendMode, "normal"));

      switch (element.type) {
        case "audio": break;
        case "effect":
          items.push({ kind: "sceneEffect", elementId: element.id, effects: [{ type: element.effectType, params }] });
          break;
        case "text":
          items.push({ kind: "text", elementId: element.id, params, opacity, blendMode, effects: resolveEffects(element, clipTime) });
          break;
        case "graphic": {
          const size = DEFAULT_GRAPHIC_SOURCE_SIZE;
          const graphicParams: ParamValues = {};
          for (const [k, v] of Object.entries(params)) graphicParams[k] = v;
          items.push({
            kind: "layer", elementId: element.id, opacity, blendMode, effects: resolveEffects(element, clipTime),
            source: { type: "graphic", definitionId: element.definitionId, params: graphicParams, width: size, height: size },
            transform: computeVisualTransform({ canvas, sourceWidth: size, sourceHeight: size, params }),
            mask: activeMask(element),
          });
          break;
        }
        case "video":
        case "image": {
          const asset = assets.get(element.mediaId);
          if (!asset || !asset.width || !asset.height) {
            missing.push(element.id);
            break;
          }
          const source = element.type === "video"
            ? ({ type: "video", mediaId: asset.id, width: asset.width, height: asset.height,
              sourceSeconds: sourceTimeAt({ trimStart: element.trimStart, clipTime, retime: element.retime }) / TICKS_PER_SECOND } as const)
            : ({ type: "image", mediaId: asset.id, width: asset.width, height: asset.height } as const);
          items.push({
            kind: "layer", elementId: element.id, opacity, blendMode, effects: resolveEffects(element, clipTime), source,
            transform: computeVisualTransform({ canvas, sourceWidth: asset.width, sourceHeight: asset.height, params }),
            mask: activeMask(element),
          });
          if (input.background.type === "blur" && track.id === tracks.main.id) {
            blurBackgrounds.push({ kind: "blurBackground", elementId: element.id, source, intensity: input.background.blurIntensity ?? DEFAULT_BACKGROUND_BLUR_INTENSITY });
          }
          break;
        }
      }
    }
  }

  return {
    width: canvas.width, height: canvas.height, time,
    backgroundColor: input.background.type === "color" && input.background.color !== "transparent" ? input.background.color : null,
    items: [...blurBackgrounds, ...items],
    missingMedia: missing,
  };
}

/** Gaussian blur sigma in pixels for a blur intensity at the given drawn size (reference 1920x1080). */
export function blurSigma(input: { intensity: number; width: number; height: number }): { x: number; y: number } {
  return { x: (input.intensity / 5) * (input.width / 1920), y: (input.intensity / 5) * (input.height / 1080) };
}

