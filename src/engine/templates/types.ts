import type { FilterPresetId, TextAnimationPreset, TransitionType } from "#/engine/model";

export const TEMPLATE_FORMAT = "runitback-template";
export const TEMPLATE_VERSION = 1;

/** Hard bounds enforced by the validator. A template is untrusted data: nothing here is open-ended. */
export const TEMPLATE_LIMITS = {
  maxBytes: 256 * 1024,
  maxDepth: 12,
  maxSlots: 24,
  maxTexts: 32,
  maxBeats: 48,
  maxLayersPerBeat: 8,
  maxRepeatGroups: 2,
  maxRepeatItems: 12,
  maxTags: 12,
  maxIdLength: 48,
  maxLabelLength: 80,
  maxDescriptionLength: 400,
  maxTextChars: 280,
  maxSeconds: 600,
  maxPlannedElements: 400,
} as const;

export const TEMPLATE_CATEGORIES = [
  "launch", "announcement", "explainer", "showcase", "social-proof", "list", "creator", "update",
] as const;
export type TemplateCategory = (typeof TEMPLATE_CATEGORIES)[number];

export const TEMPLATE_ASPECTS = ["16:9", "9:16", "1:1", "4:3"] as const;
export type TemplateAspect = (typeof TEMPLATE_ASPECTS)[number];

export const SLOT_KINDS = ["video", "image", "audio"] as const;
export type SlotKind = (typeof SLOT_KINDS)[number];

export const MEDIA_FIT = ["cover", "contain"] as const;
export type MediaFit = (typeof MEDIA_FIT)[number];

/** What a beat does when the user's clip is shorter than the beat: freeze its last frame, play it again, or end the beat early. */
export const SHORT_MEDIA_POLICIES = ["hold", "loop", "shrink"] as const;
export type ShortMediaPolicy = (typeof SHORT_MEDIA_POLICIES)[number];

export const GRAPHIC_SHAPES = ["rectangle", "ellipse", "polygon", "star"] as const;
export type GraphicShape = (typeof GRAPHIC_SHAPES)[number];

export type ParamOverrides = Record<string, number | string | boolean>;

export interface TemplateSlot {
  id: string;
  kind: SlotKind;
  label: string;
  hint?: string;
  /** An optional slot may stay empty without a warning. */
  optional?: boolean;
  /** Recommended source length in seconds (video and audio). Informational: the planner trims or holds to fit. */
  expectedSeconds?: number;
  /** Recommended source shape. Informational; `fit` decides how it is framed. */
  aspect?: TemplateAspect;
}

export interface TextAnimationChoice {
  preset: TextAnimationPreset;
  seconds?: number;
}

export interface TemplateText {
  id: string;
  label: string;
  default: string;
  maxChars?: number;
  /** Widest the text may get, in canvas pixels, before it wraps (default 90% of the canvas width). */
  maxWidth?: number;
  /** A key of `TEXT_STYLE_PRESETS`. */
  style: string;
  /** Extra look keys on top of the preset: `sizePx` and the real text param keys (`stroke.width`, `shadow.enabled`, ...). */
  overrides?: ParamOverrides;
  animation?: { in?: TextAnimationChoice; out?: TextAnimationChoice };
}

export interface Crop { left?: number; top?: number; right?: number; bottom?: number }

export interface MediaPlacement {
  slot: string;
  /** `main` is the base layer (falls back to an overlay when it would be pinned wrongly or collide); `overlay` always sits above. */
  track?: "main" | "overlay";
  fit?: MediaFit;
  crop?: Crop;
  /** Scale up about the canvas center, then shift by x/y in canvas pixels: zooms into a region of a recording. */
  zoom?: { scale: number; x?: number; y?: number };
  /** Slow push-in: animates the scale from 1x to this multiple over the clip. */
  pushIn?: number;
  filter?: { preset: FilterPresetId; intensity?: number };
  transitionIn?: { type: TransitionType; seconds?: number };
  onShort?: ShortMediaPolicy;
  /** Where in the source to start, in seconds (clamped so the source still covers the beat). */
  sourceStart?: number;
  audio?: "keep" | "mute";
  /** Size and place the clip inside a box in canvas pixels instead of filling the canvas (`fit` decides contain or cover within the box). */
  box?: PixelBox;
}

export interface PixelBox { x: number; y: number; width: number; height: number }

export interface TextLayer {
  kind: "text";
  text: string;
  /** Seconds after the beat starts (default 0). */
  at?: number;
  /** Seconds (default: until the beat ends). */
  duration?: number;
  position?: { x: number; y: number };
  animation?: { in?: TextAnimationChoice; out?: TextAnimationChoice };
}

export interface GraphicLayer {
  kind: "graphic";
  shape: GraphicShape;
  at?: number;
  duration?: number;
  /** Size and place the shape as a box in canvas pixels, from the center of the canvas. */
  box: PixelBox;
  /** Graphic params: fill, stroke, strokeWidth, cornerRadius, sides, points, depth, opacity, transform.rotate. */
  params?: ParamOverrides;
}

export type BeatLayer = TextLayer | GraphicLayer;

export interface TemplateBeat {
  id: string;
  /** Seconds from the template start (or from the start of the repeat item inside a repeat group). */
  at: number;
  duration: number;
  /** Top-level beats only: `at` is then measured from the end of this repeat group. */
  afterRepeat?: string;
  /** Top-level beats only: ignore `duration` and run until the last other clip ends (a music bed that follows the real length). */
  toEnd?: boolean;
  media?: MediaPlacement;
  layers?: BeatLayer[];
}

export interface RepeatGroup {
  id: string;
  label: string;
  min: number;
  max: number;
  /** Seconds from the template start to the first item. */
  at: number;
  /** Length of one item; items are laid out back to back. */
  itemSeconds: number;
  /** Slots and texts each item fills in; ids are scoped to the group. */
  slots: TemplateSlot[];
  texts: TemplateText[];
  /** Beats relative to the start of an item. */
  beats: TemplateBeat[];
}

export interface TemplateCaptions {
  /** A key of `CAPTION_STYLE_PRESETS`. */
  style: string;
}

export interface TemplatePreview {
  poster: string;
  video: string;
}

export interface ProjectTemplate {
  format: typeof TEMPLATE_FORMAT;
  templateVersion: typeof TEMPLATE_VERSION;
  id: string;
  name: string;
  description: string;
  category: TemplateCategory;
  tags: string[];
  canvas: { aspect: TemplateAspect; fps: number; backgroundColor?: string };
  /** Seconds of the finished video when every slot is filled with clips long enough. */
  durationSeconds: number;
  slots: TemplateSlot[];
  texts: TemplateText[];
  beats: TemplateBeat[];
  repeat?: RepeatGroup[];
  captions?: TemplateCaptions;
  preview?: TemplatePreview;
}

export type TemplateIssueCode =
  | "not-json" | "too-large" | "too-deep" | "not-an-object" | "forbidden-key" | "unknown-key" | "missing" | "wrong-type"
  | "out-of-range" | "too-many" | "bad-id" | "duplicate-id" | "unknown-ref" | "bad-value" | "unsupported-version"
  | "kind-mismatch" | "too-long" | "empty";

export interface TemplateIssue {
  code: TemplateIssueCode;
  /** JSON path of the offending value, e.g. `beats[2].media.zoom.scale`. */
  path: string;
  message: string;
}

export class TemplateValidationError extends Error {
  constructor(readonly issues: ReadonlyArray<TemplateIssue>) {
    const head = issues.slice(0, 3).map((i) => `${i.path || "(root)"}: ${i.message}`).join("; ");
    super(`Invalid template: ${head}${issues.length > 3 ? ` (+${issues.length - 3} more)` : ""}`);
    this.name = "TemplateValidationError";
  }
}
