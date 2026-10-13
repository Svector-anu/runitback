import type { FrameRate, MediaTime } from "#/engine/time";
import type { ElementAnimations, KeyframeRef } from "./animation-types";

export type ParamValue = number | string | boolean;
export type ParamValues = Record<string, ParamValue>;

export type TrackType = "video" | "text" | "audio" | "graphic" | "effect";
export type MediaType = "image" | "video" | "audio";

/** Playback rate at one position of the SOURCE media (`at`, absolute source ticks, not clip time). */
export interface SpeedCurvePoint {
  at: number;
  rate: number;
}

/**
 * A speed curve: playback rate as a piecewise-linear function of source position (rate is held flat before the first
 * and after the last point). Tied to the source rather than the clip, so trimming, splitting and resizing never move
 * the ramp relative to the footage. Between two points the rate changes linearly in source time.
 */
export interface SpeedCurve {
  /** 2 to `SPEED_CURVE_MAX_POINTS` points with strictly increasing `at`. */
  points: SpeedCurvePoint[];
}

export interface RetimeConfig {
  /** Constant playback rate; with a `curve` it is the derived mean rate (visible source length / duration). */
  rate: number;
  maintainPitch?: boolean;
  curve?: SpeedCurve;
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

export const TRANSITION_TYPES = [
  "dissolve", "fade-black", "slide-left", "slide-right", "wipe-left", "wipe-right", "zoom", "blur", "flash", "glitch",
] as const;
export type TransitionType = (typeof TRANSITION_TYPES)[number];

/**
 * Blend from the previous clip on the same track into this one. Lives on the INCOMING clip, is centred on the cut
 * (half before, half after) and never moves a clip: the previous clip plays on past its end and this one starts
 * early, using the source media either side of the cut (held on its first/last frame when there is none).
 */
export interface Transition {
  type: TransitionType;
  /** Total length in ticks; at most half of the shorter of the two clips. */
  duration: MediaTime;
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
  transition?: Transition;
}
export interface ImageElement extends BaseElement {
  type: "image";
  mediaId: string;
  /**
   * Set on a freeze frame: `mediaId` is then a VIDEO asset and this is the source time (ticks) of the one frame shown
   * for the whole clip. Otherwise the clip behaves like any image: no trims, no audio, any length.
   */
  freezeAt?: MediaTime;
  hidden?: boolean;
  effects?: Effect[];
  masks?: Mask[];
  transition?: Transition;
}
export const TEXT_ANIMATION_PRESETS = ["fade", "slide-up", "pop", "typewriter", "blur-in", "stagger-words", "type-caret", "count-up"] as const;
export type TextAnimationPreset = (typeof TEXT_ANIMATION_PRESETS)[number];

export interface TextAnimationSpec {
  preset: TextAnimationPreset;
  /** Length in ticks of the in or out phase; at most half of the clip. */
  duration: MediaTime;
}

/** Which presets generated the keyframes on opacity / position Y / scale / reveal (so setting one side keeps the other). */
export interface TextAnimationState {
  in?: TextAnimationSpec;
  out?: TextAnimationSpec;
}

export interface TextElement extends BaseElement {
  type: "text";
  hidden?: boolean;
  effects?: Effect[];
  textAnimation?: TextAnimationState;
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

export const GRADIENT_STYLES = ["linear", "radial", "mesh"] as const;
export type GradientStyle = (typeof GRADIENT_STYLES)[number];
export const GRADIENT_MIN_COLORS = 2;
export const GRADIENT_MAX_COLORS = 6;

/**
 * A gradient canvas background. `linear` runs along `angle` (CSS convention: 0 = towards the top, 90 = towards the right),
 * `radial` spreads from the middle, `mesh` blends one soft blob per colour. `motion` (0-100) drifts it over time: it turns
 * a linear gradient, orbits a radial one and floats the mesh blobs; 0 holds it still.
 */
export interface GradientBackground {
  type: "gradient";
  style: GradientStyle;
  /** 2 to 6 hex colours (#rrggbb), first to last. */
  colors: string[];
  angle: number;
  motion: number;
}

export type Background = { type: "color"; color: string } | { type: "blur"; blurIntensity: number } | GradientBackground;
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
  /** Media assets that belong to the project; bytes live in the AssetRepository. */
  assetIds: string[];
  version: number;
  /** Set only on a project that was repaired while loading; never written back to storage. */
  repairNotes?: string[];
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
  /** Set when the file was produced by a generation model instead of imported from disk. */
  generated?: GeneratedProvenance;
}

/** Where a generated asset came from, kept with the asset so the "Generated" label and prompt survive reloads. */
export interface GeneratedProvenance {
  prompt: string;
  model: string;
  provider: string;
  /** ISO 8601. */
  createdAt: string;
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
  transition?: Transition | undefined;
  isSourceAudioEnabled?: boolean;
}
