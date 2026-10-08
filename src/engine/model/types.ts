import type { FrameRate, MediaTime } from "#/engine/time";
import type { ElementAnimations, KeyframeRef } from "./animation-types";

export type ParamValue = number | string | boolean;
export type ParamValues = Record<string, ParamValue>;

export type TrackType = "video" | "text" | "audio" | "graphic" | "effect";
export type MediaType = "image" | "video" | "audio";

export interface RetimeConfig {
  rate: number;
  maintainPitch?: boolean;
}

export interface Effect {
  id: string;
  type: string;
  params: ParamValues;
  enabled: boolean;
}

export type MaskType =
  | "split" | "cinematic-bars" | "rectangle" | "ellipse" | "heart" | "diamond" | "star";

export interface Mask {
  id: string;
  type: MaskType;
  params: ParamValues;
}

interface BaseElement {
  id: string;
  name: string;
  /** Timeline position. */
  startTime: MediaTime;
  /** On-timeline length. */
  duration: MediaTime;
  /** Source time removed from the head / tail (unaffected by speed). */
  trimStart: MediaTime;
  trimEnd: MediaTime;
  sourceDuration?: MediaTime;
  params: ParamValues;
  animations?: ElementAnimations;
}

export interface VideoElement extends BaseElement {
  type: "video";
  mediaId: string;
  isSourceAudioEnabled?: boolean;
  hidden?: boolean;
  retime?: RetimeConfig;
  effects?: Effect[];
  masks?: Mask[];
}
export interface ImageElement extends BaseElement {
  type: "image";
  mediaId: string;
  hidden?: boolean;
  effects?: Effect[];
  masks?: Mask[];
}
export interface TextElement extends BaseElement {
  type: "text";
  hidden?: boolean;
  effects?: Effect[];
}
export interface GraphicElement extends BaseElement {
  type: "graphic";
  definitionId: string;
  hidden?: boolean;
  effects?: Effect[];
  masks?: Mask[];
}
export interface EffectElement extends BaseElement {
  type: "effect";
  /** Scene-wide effect: applies to everything drawn below it; parameters live in `params`. */
  effectType: string;
}
export interface AudioElement extends BaseElement {
  type: "audio";
  mediaId: string;
  retime?: RetimeConfig;
}

export type VisualElement = VideoElement | ImageElement | TextElement | GraphicElement;
export type TimelineElement = VideoElement | ImageElement | TextElement | GraphicElement | EffectElement | AudioElement;
export type ElementType = TimelineElement["type"];

export interface BaseTrack { id: string; name: string }
export interface VideoTrack extends BaseTrack { type: "video"; elements: Array<VideoElement | ImageElement>; muted: boolean; hidden: boolean }
export interface TextTrack extends BaseTrack { type: "text"; elements: TextElement[]; hidden: boolean }
export interface AudioTrack extends BaseTrack { type: "audio"; elements: AudioElement[]; muted: boolean }
export interface GraphicTrack extends BaseTrack { type: "graphic"; elements: GraphicElement[]; hidden: boolean }
export interface EffectTrack extends BaseTrack { type: "effect"; elements: EffectElement[]; hidden: boolean }

export type OverlayTrack = VideoTrack | TextTrack | GraphicTrack | EffectTrack;
export type TimelineTrack = OverlayTrack | AudioTrack;

export interface SceneTracks {
  /** overlay[0] is the topmost layer. */
  overlay: OverlayTrack[];
  main: VideoTrack;
  audio: AudioTrack[];
}

export interface Bookmark {
  time: MediaTime;
  note?: string;
  color?: string;
  duration?: MediaTime;
}

export interface Scene {
  id: string;
  name: string;
  isMain: boolean;
  tracks: SceneTracks;
  bookmarks: Bookmark[];
  createdAt: string;
  updatedAt: string;
}

export type Background = { type: "color"; color: string } | { type: "blur"; blurIntensity: number };
export interface CanvasSize { width: number; height: number }

export interface ProjectSettings {
  fps: FrameRate;
  canvasSize: CanvasSize;
  canvasSizeMode: "preset" | "custom";
  originalCanvasSize: CanvasSize | null;
  background: Background;
}

export interface TimelineViewState {
  zoomLevel: number;
  scrollLeft: number;
  playheadTime: MediaTime;
}

export interface ProjectMetadata {
  id: string;
  name: string;
  thumbnail?: string;
  duration: MediaTime;
  createdAt: string;
  updatedAt: string;
}

export interface Project {
  metadata: ProjectMetadata;
  scenes: Scene[];
  currentSceneId: string;
  settings: ProjectSettings;
  timelineViewState: TimelineViewState;
  version: number;
}

export interface MediaAssetInfo {
  id: string;
  name: string;
  type: MediaType;
  size: number;
  lastModified: number;
  width?: number;
  height?: number;
  /** Source length; absent for images. */
  duration?: MediaTime;
  fps?: FrameRate;
  hasAudio?: boolean;
  /** Small JPEG data URL. */
  thumbnail?: string;
}

export interface ElementRef { trackId: string; elementId: string }

export interface SelectionState {
  elements: ElementRef[];
  keyframes: KeyframeRef[];
  keyframeAnchor: KeyframeRef | null;
}

export const EMPTY_SELECTION: SelectionState = { elements: [], keyframes: [], keyframeAnchor: null };

/** Fields a command may change on any element; applied through the update pipeline. */
export interface ElementPatch {
  name?: string;
  startTime?: MediaTime;
  duration?: MediaTime;
  trimStart?: MediaTime;
  trimEnd?: MediaTime;
  params?: ParamValues;
  animations?: ElementAnimations | undefined;
  retime?: RetimeConfig | undefined;
  hidden?: boolean;
  effects?: Effect[] | undefined;
  masks?: Mask[] | undefined;
  isSourceAudioEnabled?: boolean;
}
