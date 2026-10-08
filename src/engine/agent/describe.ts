import {
  AUDIO_DEFAULTS, EFFECT_DEFINITIONS, GRAPHIC_DEFINITIONS, TEXT_DEFAULTS, TRANSFORM_DEFAULTS, VIDEO_DEFAULTS, defaultsOf,
  type AnimationBinding, type Effect, type Mask, type ParamValue, type ParamValues, type TimelineElement, type TimelineTrack,
} from "#/engine/model";
import { elementEnd, type LocatedElement } from "#/engine/timeline";
import { toSec } from "./env";

type Decorated = TimelineElement & { effects?: Effect[]; masks?: Mask[]; hidden?: boolean; mediaId?: string };

function defaultsFor(element: TimelineElement): ParamValues {
  switch (element.type) {
    case "video": return VIDEO_DEFAULTS;
    case "image": return TRANSFORM_DEFAULTS;
    case "audio": return AUDIO_DEFAULTS;
    case "text": return TEXT_DEFAULTS;
    case "graphic": return { ...TRANSFORM_DEFAULTS, ...defaultsOf(GRAPHIC_DEFINITIONS[element.definitionId]?.params ?? []) };
    case "effect": return defaultsOf(EFFECT_DEFINITIONS[element.effectType]?.params ?? []);
  }
}

/** Params that differ from their defaults (text content is always shown): the "key params" of get_timeline. */
export function keyParams(element: TimelineElement): ParamValues {
  const defaults = defaultsFor(element);
  const out: ParamValues = {};
  for (const [key, value] of Object.entries(element.params)) {
    if (defaults[key] !== value || (element.type === "text" && key === "content")) out[key] = value;
  }
  return out;
}

export function speedOf(element: TimelineElement): number {
  return "retime" in element && element.retime ? element.retime.rate : 1;
}

export interface KeyframeInfo {
  id: string;
  /** Seconds from the start of the element. */
  time: number;
  value?: ParamValue;
}

export function keyframesOf(binding: AnimationBinding | undefined): KeyframeInfo[] {
  if (!binding) return [];
  const channel = binding.kind === "channel" ? binding.channel : binding.channels.r;
  const showValue = binding.kind === "channel";
  return channel.keys.map((key) => ({ id: key.id, time: toSec(key.time), ...(showValue ? { value: key.value } : {}) }));
}

export function hasKeyframes(element: TimelineElement): boolean {
  return Object.values(element.animations ?? {}).some((binding) => binding !== undefined);
}

export function summarizeElement(located: LocatedElement): Record<string, unknown> {
  const element = located.element as Decorated;
  return {
    id: element.id,
    type: element.type,
    name: element.name,
    trackId: located.track.id,
    start: toSec(element.startTime),
    end: toSec(elementEnd(element)),
    duration: toSec(element.duration),
    trimStart: toSec(element.trimStart),
    speed: speedOf(element),
    ...(element.mediaId ? { assetId: element.mediaId } : {}),
    ...(element.type === "graphic" ? { shape: element.definitionId } : {}),
    ...(element.type === "effect" ? { effectType: element.effectType } : {}),
    ...(element.hidden ? { hidden: true } : {}),
    params: keyParams(element),
    hasKeyframes: hasKeyframes(element),
    hasEffects: (element.effects?.length ?? 0) > 0,
    hasMasks: (element.masks?.length ?? 0) > 0,
  };
}

export function describeElementFull(located: LocatedElement): Record<string, unknown> {
  const element = located.element as Decorated;
  const animations: Record<string, { keyframes: KeyframeInfo[] }> = {};
  for (const [path, binding] of Object.entries(element.animations ?? {})) {
    if (binding) animations[path] = { keyframes: keyframesOf(binding) };
  }
  return {
    ...summarizeElement(located),
    trackKind: located.track.type,
    trimEnd: toSec(element.trimEnd),
    sourceDuration: element.sourceDuration === undefined ? undefined : toSec(element.sourceDuration),
    sourceAudioEnabled: element.type === "video" ? element.isSourceAudioEnabled !== false : undefined,
    params: element.params,
    animations,
    effects: (element.effects ?? []).map((e) => ({ id: e.id, type: e.type, enabled: e.enabled, params: e.params })),
    masks: (element.masks ?? []).map((m) => ({ id: m.id, type: m.type, params: m.params })),
  };
}

export interface Gap { start: number; end: number }

/** Empty spans on a track from t=0 up to its last element. */
export function gapsOf(track: TimelineTrack): Gap[] {
  const sorted = [...(track.elements as TimelineElement[])].sort((a, b) => a.startTime - b.startTime);
  const gaps: Gap[] = [];
  let cursor = 0;
  for (const element of sorted) {
    if (element.startTime > cursor) gaps.push({ start: toSec(cursor), end: toSec(element.startTime) });
    cursor = Math.max(cursor, elementEnd(element));
  }
  return gaps;
}
