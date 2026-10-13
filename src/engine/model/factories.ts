import { DEFAULT_FPS, mediaTime, mediaTimeFromSeconds, type MediaTime } from "#/engine/time";
import { DEFAULT_NEW_ELEMENT_SECONDS, IMAGE_DEFAULTS, TEXT_DEFAULTS, TRANSFORM_DEFAULTS, VIDEO_DEFAULTS, AUDIO_DEFAULTS } from "./params";
import type { IdGenerator } from "./ids";
import type {
  AudioElement, AudioTrack, EffectElement, EffectTrack, GraphicElement, GraphicTrack, ImageElement, MediaAssetInfo,
  ParamValues, Project, Scene, SceneTracks, TextElement, TextTrack, TrackType, VideoElement, VideoTrack,
  OverlayTrack, TimelineTrack,
} from "./types";

/**
 * v1: initial. v2: optional `transition` on video/image clips. v3: the `adjust` effect type. v4: text stroke/shadow/reveal
 * params and `textAnimation`. v5: `crop.*` params and `freezeAt` on image clips. v6: speed curves, chroma key, background removal.
 * v7: template effects (text blur/stagger/caret/highlight/count-up, gradient background, more transitions, tilt, shadow, cursor and frames). All additive; older projects need no data change.
 */
export const PROJECT_SCHEMA_VERSION = 7;
export const MAIN_TRACK_NAME = "Main Track";
export const CANVAS_PRESETS = [
  { width: 1920, height: 1080 },
  { width: 1080, height: 1920 },
  { width: 1080, height: 1080 },
  { width: 1440, height: 1080 },
] as const;

const TRACK_NAMES: Record<TrackType, string> = {
  video: "Video track",
  text: "Text track",
  audio: "Audio track",
  graphic: "Graphic track",
  effect: "Effect track",
};

export function createMainTrack(id: string): VideoTrack {
  return { id, name: MAIN_TRACK_NAME, type: "video", elements: [], muted: false, hidden: false };
}

export function createEmptyTracks(ids: IdGenerator): SceneTracks {
  return { overlay: [], main: createMainTrack(ids()), audio: [] };
}

export function createTrack(type: "audio", id: string): AudioTrack;
export function createTrack(type: Exclude<TrackType, "audio">, id: string): OverlayTrack;
export function createTrack(type: TrackType, id: string): TimelineTrack;
export function createTrack(type: TrackType, id: string): TimelineTrack {
  const name = TRACK_NAMES[type];
  switch (type) {
    case "video": return { id, name, type, elements: [], muted: false, hidden: false };
    case "audio": return { id, name, type, elements: [], muted: false };
    case "text": return { id, name, type, elements: [], hidden: false } satisfies TextTrack;
    case "graphic": return { id, name, type, elements: [], hidden: false } satisfies GraphicTrack;
    case "effect": return { id, name, type, elements: [], hidden: false } satisfies EffectTrack;
  }
}

export function createScene(input: { id: string; name: string; isMain: boolean; ids: IdGenerator; now: string }): Scene {
  return {
    id: input.id, name: input.name, isMain: input.isMain,
    tracks: createEmptyTracks(input.ids), bookmarks: [],
    createdAt: input.now, updatedAt: input.now,
  };
}

export function createProject(input: { id: string; name: string; ids: IdGenerator; now: string }): Project {
  const scene = createScene({ id: input.ids(), name: "Main scene", isMain: true, ids: input.ids, now: input.now });
  return {
    metadata: { id: input.id, name: input.name, duration: mediaTime(0), createdAt: input.now, updatedAt: input.now },
    scenes: [scene],
    currentSceneId: scene.id,
    settings: {
      fps: DEFAULT_FPS,
      canvasSize: { ...CANVAS_PRESETS[0] },
      canvasSizeMode: "preset",
      originalCanvasSize: null,
      background: { type: "color", color: "#000000" },
    },
    timelineViewState: { zoomLevel: 1, scrollLeft: 0, playheadTime: mediaTime(0) },
    assetIds: [],
    version: PROJECT_SCHEMA_VERSION,
  };
}

export const DEFAULT_ELEMENT_DURATION: MediaTime = mediaTimeFromSeconds(DEFAULT_NEW_ELEMENT_SECONDS);

type Common = { id: string; startTime: MediaTime; name?: string };

export function buildMediaElement(input: Common & { asset: MediaAssetInfo }): VideoElement | ImageElement | AudioElement {
  const { asset } = input;
  const name = input.name ?? asset.name;
  const duration = asset.type === "image" || asset.duration === undefined ? DEFAULT_ELEMENT_DURATION : asset.duration;
  const base = { id: input.id, name, startTime: input.startTime, duration, trimStart: mediaTime(0), trimEnd: mediaTime(0) };
  switch (asset.type) {
    case "video":
      return { ...base, type: "video", mediaId: asset.id, sourceDuration: duration,
        isSourceAudioEnabled: asset.hasAudio !== false, hidden: false, params: { ...VIDEO_DEFAULTS } };
    case "audio":
      return { ...base, type: "audio", mediaId: asset.id, sourceDuration: duration, params: { ...AUDIO_DEFAULTS } };
    case "image":
      return { ...base, type: "image", mediaId: asset.id, hidden: false, params: { ...IMAGE_DEFAULTS } };
  }
}

export function buildTextElement(input: Common & { content?: string; duration?: MediaTime }): TextElement {
  const params: ParamValues = { ...TEXT_DEFAULTS };
  if (input.content !== undefined) params.content = input.content;
  return {
    id: input.id, type: "text", name: input.name ?? "Text", startTime: input.startTime,
    duration: input.duration ?? DEFAULT_ELEMENT_DURATION, trimStart: mediaTime(0), trimEnd: mediaTime(0), params, hidden: false,
  };
}

export function buildGraphicElement(input: Common & { definitionId: string; params?: ParamValues }): GraphicElement {
  const name = input.name ?? input.definitionId.charAt(0).toUpperCase() + input.definitionId.slice(1);
  return {
    id: input.id, type: "graphic", name, definitionId: input.definitionId, startTime: input.startTime,
    duration: DEFAULT_ELEMENT_DURATION, trimStart: mediaTime(0), trimEnd: mediaTime(0),
    params: { ...TRANSFORM_DEFAULTS, ...input.params }, hidden: false,
  };
}

export function buildEffectElement(input: Common & { effectType: string; params: ParamValues }): EffectElement {
  const name = input.name ?? input.effectType.charAt(0).toUpperCase() + input.effectType.slice(1);
  return {
    id: input.id, type: "effect", name, effectType: input.effectType, startTime: input.startTime,
    duration: DEFAULT_ELEMENT_DURATION, trimStart: mediaTime(0), trimEnd: mediaTime(0), params: { ...input.params },
  };
}

/** True when no scene in the project has any element, so "first run" cannot resurface from creating a blank scene later. */
export function projectHasNoElements(scenes: ReadonlyArray<Scene>): boolean {
  return scenes.every(({ tracks }) => tracks.main.elements.length === 0
    && tracks.overlay.every((track) => track.elements.length === 0)
    && tracks.audio.every((track) => track.elements.length === 0));
}
