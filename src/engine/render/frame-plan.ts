import {
  BLEND_MODES, CROP_MAX_EDGE, DEFAULT_GRAPHIC_SOURCE_SIZE, numberParam, stringParam, PARAM, type BlendMode, type CanvasSize,
  type Background, type Effect, type GradientBackground, type Mask, type MediaAssetInfo, type ParamValues, type SceneTracks, type TimelineElement,
  type TimelineTrack, type TransitionType,
} from "#/engine/model";
import { TICKS_PER_SECOND } from "#/engine/time";
import { effectiveTransition, resolveEffectParams, resolveElementParams, sourceTimeAt } from "#/engine/timeline";
import { activeGradient } from "./gradient";
import { resolveTilt, type LayerTilt } from "./perspective";
import { easeTransition, isTransitionLayerVisible, type LayerTransition } from "./transitions";

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

/** Fractions of the source removed from each side; the remaining part is drawn where it was. */
export interface LayerCrop { left: number; top: number; right: number; bottom: number }

/** Crop from the `crop.*` params, clamped so something always remains; null when nothing is cropped. */
export function resolveCrop(params: ParamValues): LayerCrop | null {
  const edge = (key: string): number => Math.min(CROP_MAX_EDGE, Math.max(0, numberParam(params, key, 0)));
  let { left, right, top, bottom } = { left: edge(PARAM.cropLeft), right: edge(PARAM.cropRight), top: edge(PARAM.cropTop), bottom: edge(PARAM.cropBottom) };
  if (left + right > CROP_MAX_EDGE) { const k = CROP_MAX_EDGE / (left + right); left *= k; right *= k; }
  if (top + bottom > CROP_MAX_EDGE) { const k = CROP_MAX_EDGE / (top + bottom); top *= k; bottom *= k; }
  return left + right + top + bottom === 0 ? null : { left, top, right, bottom };
}

export interface MediaLayer extends LayerBase {
  kind: "layer";
  source: LayerSource;
  transform: LayerTransform;
  mask: ResolvedMask | null;
  crop: LayerCrop | null;
  /** Perspective tilt about the layer's centre; null while flat. */
  tilt: LayerTilt | null;
  /** Set while this clip is part of a transition (also outside its own start/end, using the media either side of the cut). */
  transition: LayerTransition | null;
}

export interface TextLayer extends LayerBase {
  kind: "text";
  params: ParamValues;
  /** Seconds into the clip; drives the blinking caret. */
  seconds: number;
  tilt: LayerTilt | null;
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
  /** Gradient drawn over the base fill when the project background is a gradient. */
  backgroundGradient: GradientBackground | null;
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

/** Last frame of a source is never requested exactly: a decoder seeking to the very end can return nothing. */
const SOURCE_END_GUARD_TICKS = 4000;

interface TransitionWindow {
  outgoingId: string;
  incomingId: string;
  type: TransitionType;
  start: number;
  duration: number;
}

/** Windows are centred on the cut between a clip and its predecessor: half before it, half after. */
function transitionWindows(elements: TimelineElement[]): TransitionWindow[] {
  const out: TransitionWindow[] = [];
  for (const element of elements) {
    const transition = effectiveTransition(elements, element);
    const outgoing = transition && elements.find((e) => e.id !== element.id && e.startTime + e.duration === element.startTime && (e.type === "video" || e.type === "image"));
    if (!transition || !outgoing) continue;
    out.push({
      outgoingId: outgoing.id, incomingId: element.id, type: transition.type,
      start: element.startTime - Math.floor(transition.duration / 2), duration: transition.duration,
    });
  }
  return out;
}

function transitionRole(windows: TransitionWindow[], elementId: string, time: number): LayerTransition | null {
  for (const w of windows) {
    if (time < w.start || time >= w.start + w.duration) continue;
    if (w.incomingId !== elementId && w.outgoingId !== elementId) continue;
    return { type: w.type, role: w.incomingId === elementId ? "in" : "out", progress: easeTransition((time - w.start) / w.duration) };
  }
  return null;
}

/** Source time at an unclamped clip time; held on the first/last frame where the source runs out. */
function heldSourceSeconds(input: { element: Extract<TimelineElement, { type: "video" }>; assetDuration: number | undefined; clipTime: number }): number {
  const { element } = input;
  const raw = sourceTimeAt({ trimStart: element.trimStart, clipTime: input.clipTime, retime: element.retime });
  const known = element.sourceDuration ?? input.assetDuration;
  const first = known === undefined ? element.trimStart : 0;
  const last = known === undefined
    ? sourceTimeAt({ trimStart: element.trimStart, clipTime: element.duration, retime: element.retime }) - SOURCE_END_GUARD_TICKS
    : known - SOURCE_END_GUARD_TICKS;
  return Math.max(first, Math.min(raw, Math.max(first, last))) / TICKS_PER_SECOND;
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
    const elements = visibleElements(track);
    const windows = track.type === "video" ? transitionWindows(elements) : [];
    for (const element of elements) {
      const transition = windows.length > 0 ? transitionRole(windows, element.id, time) : null;
      const active = isActive(element, time);
      if (!active && !transition) continue;
      if (transition && !isTransitionLayerVisible(transition)) continue;
      const rawClipTime = time - element.startTime;
      const clipTime = Math.min(Math.max(0, rawClipTime), Math.max(0, element.duration - 1));
      const params = resolveElementParams(element, clipTime);
      const opacity = numberParam(params, PARAM.opacity, 1);
      const blendMode = blendModeOf(stringParam(params, PARAM.blendMode, "normal"));

      switch (element.type) {
        case "audio": break;
        case "effect":
          items.push({ kind: "sceneEffect", elementId: element.id, effects: [{ type: element.effectType, params }] });
          break;
        case "text": {
          const blur = numberParam(params, PARAM.blur, 0);
          const effects = resolveEffects(element, clipTime);
          items.push({
            kind: "text", elementId: element.id, params, opacity, blendMode, seconds: clipTime / TICKS_PER_SECOND, tilt: resolveTilt(params),
            effects: blur > 0 ? [{ type: "blur", params: { intensity: blur } }, ...effects] : effects,
          });
          break;
        }
        case "graphic": {
          const size = DEFAULT_GRAPHIC_SOURCE_SIZE;
          const graphicParams: ParamValues = {};
          for (const [k, v] of Object.entries(params)) graphicParams[k] = v;
          items.push({
            kind: "layer", elementId: element.id, opacity, blendMode, effects: resolveEffects(element, clipTime),
            source: { type: "graphic", definitionId: element.definitionId, params: graphicParams, width: size, height: size },
            transform: computeVisualTransform({ canvas, sourceWidth: size, sourceHeight: size, params }),
            mask: activeMask(element), crop: null, tilt: resolveTilt(params), transition: null,
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
              sourceSeconds: transition
                ? heldSourceSeconds({ element, assetDuration: asset.duration, clipTime: rawClipTime })
                : sourceTimeAt({ trimStart: element.trimStart, clipTime, retime: element.retime }) / TICKS_PER_SECOND } as const)
            : element.freezeAt !== undefined
              ? ({ type: "video", mediaId: asset.id, width: asset.width, height: asset.height, sourceSeconds: element.freezeAt / TICKS_PER_SECOND } as const)
              : ({ type: "image", mediaId: asset.id, width: asset.width, height: asset.height } as const);
          items.push({
            kind: "layer", elementId: element.id, opacity, blendMode, effects: resolveEffects(element, clipTime), source,
            transform: computeVisualTransform({ canvas, sourceWidth: asset.width, sourceHeight: asset.height, params }),
            mask: activeMask(element), crop: resolveCrop(params), tilt: resolveTilt(params), transition,
          });
          if (active && input.background.type === "blur" && track.id === tracks.main.id) {
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
    backgroundGradient: activeGradient(input.background),
    items: [...blurBackgrounds, ...items],
    missingMedia: missing,
  };
}

/** Gaussian blur sigma in pixels for a blur intensity at the given drawn size (reference 1920x1080). */
export function blurSigma(input: { intensity: number; width: number; height: number }): { x: number; y: number } {
  return { x: (input.intensity / 5) * (input.width / 1920), y: (input.intensity / 5) * (input.height / 1080) };
}

