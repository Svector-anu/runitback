import { maxTextAnimationDuration } from "#/engine/animation";
import {
  CROP_MAX_EDGE, PARAM, TEXT_SIZE_REFERENCE_HEIGHT, type FilterPresetId, type MediaAssetInfo, type ParamValues, type TextAnimationPreset,
  type TransitionType,
} from "#/engine/model";
import {
  TICKS_PER_SECOND, floorToFrame, frameDuration, frameRateFromFloat, mediaTime, mediaTimeFromSeconds, roundToFrame, type FrameRate, type MediaTime,
} from "#/engine/time";
import { ASPECT_SIZES, CAPTION_STYLE_PRESETS, TEXT_STYLE_PRESETS } from "./presets";
import {
  TEMPLATE_LIMITS, type BeatLayer, type MediaPlacement, type PixelBox, type ProjectTemplate, type RepeatGroup, type ShortMediaPolicy,
  type TemplateBeat, type TemplateSlot, type TemplateText, type TextAnimationChoice,
} from "./types";

export interface RepeatItemInput {
  slots?: Readonly<Record<string, string>>;
  texts?: Readonly<Record<string, string>>;
}

export interface CaptionCueInput { start: number; end: number; text: string }

/** What the user supplies. Slots map a slot id to an asset id; texts map a text id to the words to show. */
export interface TemplateInputs {
  slots?: Readonly<Record<string, string>>;
  texts?: Readonly<Record<string, string>>;
  repeat?: Readonly<Record<string, ReadonlyArray<RepeatItemInput>>>;
  /** Caption cues in seconds on the output timeline; styled with the template's caption preset when it has one. */
  captionCues?: ReadonlyArray<CaptionCueInput>;
}

export type TemplateWarningCode =
  | "missing-slot" | "unknown-asset" | "wrong-kind" | "short-media" | "text-truncated" | "text-shrunk" | "repeat-count"
  | "transition-skipped" | "caption-skipped" | "too-many-clips" | "unknown-input";

export interface TemplateWarning {
  code: TemplateWarningCode;
  message: string;
}

export interface PlannedKeyframe { path: string; time: number; value: number }

interface PlannedBase {
  /** Position in the plan; stable for a given template and input. */
  key: number;
  name: string;
  start: MediaTime;
  duration: MediaTime;
  /** Insertion layer: lower is drawn first (further back). */
  z: number;
}

export interface PlannedMedia extends PlannedBase {
  type: "video" | "image" | "audio";
  assetId: string;
  placement: "main" | "overlay" | "audio";
  trimStart: MediaTime;
  trimEnd: MediaTime;
  /** Set on a held frame: the video asset is shown frozen at this source time. */
  freezeAt?: MediaTime;
  sourceDuration?: MediaTime;
  params: ParamValues;
  muteSource: boolean;
  filter?: { preset: FilterPresetId; intensity: number };
  transition?: { type: TransitionType; duration: MediaTime };
  keyframes: PlannedKeyframe[];
}

export interface PlannedText extends PlannedBase {
  type: "text";
  params: ParamValues;
  animation?: { in?: { preset: TextAnimationPreset; duration: MediaTime }; out?: { preset: TextAnimationPreset; duration: MediaTime } };
}

export interface PlannedGraphic extends PlannedBase {
  type: "graphic";
  shape: string;
  params: ParamValues;
}

export type PlannedClip = PlannedMedia | PlannedText | PlannedGraphic;

export interface TemplatePlan {
  templateId: string;
  canvas: { width: number; height: number };
  fps: FrameRate;
  backgroundColor?: string;
  clips: PlannedClip[];
  warnings: TemplateWarning[];
  /** Required slots (top level and per repeat item) that got no usable media. */
  missingSlots: string[];
  /** End of the last planned clip. */
  endTime: MediaTime;
}

const Z = { media: 20, graphic: 30, text: 40, caption: 50, audio: 10 } as const;
const GLYPH_WIDTH_RATIO = 0.6;
const MAX_TEXT_WIDTH_RATIO = 0.9;
const MIN_TEXT_SHRINK = 0.45;
const FREEZE_END_GUARD_TICKS = 4000;
const MAX_LOOP_COPIES = 12;
const DEFAULT_TEXT_ANIMATION_SECONDS = 0.5;
const DEFAULT_TRANSITION_SECONDS = 0.5;
const PX_PER_CANVAS_EPSILON = 1e-6;

const isVisual = (asset: MediaAssetInfo): boolean => asset.type === "video" || asset.type === "image";

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/** Greedy word wrap on an estimated glyph width; shrinks the font when a single word still overflows. */
function fitText(input: { content: string; sizePx: number; letterSpacing: number; maxWidth: number }): { content: string; sizePx: number; shrunk: boolean } {
  const advance = (sizePx: number): number => sizePx * GLYPH_WIDTH_RATIO + input.letterSpacing;
  let sizePx = input.sizePx;
  const longestWord = Math.max(1, ...input.content.split(/\s+/).map((w) => w.length));
  const widest = longestWord * advance(sizePx);
  let shrunk = false;
  if (widest > input.maxWidth) {
    sizePx = Math.max(input.sizePx * MIN_TEXT_SHRINK, (input.maxWidth / longestWord - input.letterSpacing) / GLYPH_WIDTH_RATIO);
    shrunk = true;
  }
  const maxChars = Math.max(1, Math.floor(input.maxWidth / advance(sizePx)));
  const lines: string[] = [];
  for (const paragraph of input.content.split("\n")) {
    let line = "";
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      const candidate = line ? `${line} ${word}` : word;
      if (line && candidate.length > maxChars) {
        lines.push(line);
        line = word;
      } else line = candidate;
    }
    lines.push(line);
  }
  return { content: lines.join("\n"), sizePx, shrunk };
}

interface Rect { left: number; top: number; right: number; bottom: number }

/**
 * Where and how big a visual source is drawn so the part to show fills `box` (cover) or sits inside it (contain).
 * Returns the editor's own params: `transform.scale*` is relative to the contain-fit of the source in the canvas,
 * and a crop leaves the remainder where it was, so the position compensates for the crop centre.
 */
function frameVisual(input: {
  asset: Pick<MediaAssetInfo, "width" | "height">; canvas: { width: number; height: number }; media: MediaPlacement | undefined;
}): { params: ParamValues; zoomed: boolean } {
  const { asset, canvas, media } = input;
  const aw = asset.width;
  const ah = asset.height;
  if (!aw || !ah) return { params: {}, zoomed: false };
  const contain = Math.min(canvas.width / aw, canvas.height / ah);
  const fullCanvas: PixelBox = { x: 0, y: 0, width: canvas.width, height: canvas.height };
  const box = media?.box ?? fullCanvas;
  const fit = media?.fit ?? "cover";
  const crop = media?.crop ?? {};
  const visible: Rect = {
    left: (crop.left ?? 0) * aw, top: (crop.top ?? 0) * ah, right: aw - (crop.right ?? 0) * aw, bottom: ah - (crop.bottom ?? 0) * ah,
  };
  const boxed = media?.box !== undefined;
  if (boxed && fit === "cover") {
    const vw = visible.right - visible.left;
    const vh = visible.bottom - visible.top;
    const boxAspect = box.width / box.height;
    if (vw / vh > boxAspect) {
      const keep = vh * boxAspect;
      const cx = (visible.left + visible.right) / 2;
      visible.left = cx - keep / 2;
      visible.right = cx + keep / 2;
    } else {
      const keep = vw / boxAspect;
      const cy = (visible.top + visible.bottom) / 2;
      visible.top = cy - keep / 2;
      visible.bottom = cy + keep / 2;
    }
  }
  const vw = visible.right - visible.left;
  const vh = visible.bottom - visible.top;
  let scale = fit === "cover" ? Math.max(box.width / vw, box.height / vh) : Math.min(box.width / vw, box.height / vh);
  const cx = (visible.left + visible.right) / 2;
  const cy = (visible.top + visible.bottom) / 2;
  let positionX = box.x + (aw / 2 - cx) * scale;
  let positionY = box.y + (ah / 2 - cy) * scale;
  const zoom = media?.zoom;
  if (zoom) {
    scale *= zoom.scale;
    positionX = positionX * zoom.scale - (zoom.x ?? 0) * zoom.scale;
    positionY = positionY * zoom.scale - (zoom.y ?? 0) * zoom.scale;
  }
  const edge = (v: number, total: number): number => Math.min(CROP_MAX_EDGE, Math.max(0, v / total));
  const params: ParamValues = {
    [PARAM.scaleX]: round3(scale / contain), [PARAM.scaleY]: round3(scale / contain),
    [PARAM.positionX]: Math.round(positionX), [PARAM.positionY]: Math.round(positionY),
    [PARAM.cropLeft]: round3(edge(visible.left, aw)), [PARAM.cropTop]: round3(edge(visible.top, ah)),
    [PARAM.cropRight]: round3(edge(aw - visible.right, aw)), [PARAM.cropBottom]: round3(edge(ah - visible.bottom, ah)),
  };
  return { params, zoomed: zoom !== undefined };
}

interface Scope {
  slots: ReadonlyMap<string, TemplateSlot>;
  texts: ReadonlyMap<string, TemplateText>;
  slotAssets: Readonly<Record<string, string>>;
  textValues: Readonly<Record<string, string>>;
  /** Seconds added to every beat start in this scope (repeat items). */
  offset: number;
  label: string;
  /** 1-based item number and item count inside a repeat group; `{n}` and `{count}` in a text become these. */
  item?: { n: number; count: number };
}

class Planner {
  readonly clips: PlannedClip[] = [];
  readonly warnings: TemplateWarning[] = [];
  readonly missing = new Set<string>();
  private nextKey = 0;
  private readonly warned = new Set<string>();
  readonly fps: FrameRate;
  readonly canvas: { width: number; height: number };
  private readonly assets: ReadonlyMap<string, MediaAssetInfo>;

  constructor(readonly template: ProjectTemplate, assets: ReadonlyArray<MediaAssetInfo>) {
    this.fps = frameRateFromFloat(template.canvas.fps);
    this.canvas = { ...ASPECT_SIZES[template.canvas.aspect] };
    this.assets = new Map(assets.map((a) => [a.id, a]));
  }

  warn(code: TemplateWarningCode, message: string): void {
    const id = `${code}:${message}`;
    if (this.warned.has(id)) return;
    this.warned.add(id);
    this.warnings.push({ code, message });
  }

  tick(seconds: number): MediaTime {
    return roundToFrame(mediaTimeFromSeconds(seconds), this.fps);
  }

  /** [start, start + duration] on the frame grid; adjacent spans that share a boundary in seconds share it in ticks. */
  span(startSeconds: number, durationSeconds: number): { start: MediaTime; duration: MediaTime } {
    const start = this.tick(startSeconds);
    const end = this.tick(startSeconds + durationSeconds);
    return { start, duration: mediaTime(Math.max(frameDuration(this.fps), end - start)) };
  }

  push(clip: Omit<PlannedMedia, "key"> | Omit<PlannedText, "key"> | Omit<PlannedGraphic, "key">): boolean {
    if (this.clips.length >= TEMPLATE_LIMITS.maxPlannedElements) {
      this.warn("too-many-clips", `The template stopped at ${TEMPLATE_LIMITS.maxPlannedElements} clips.`);
      return false;
    }
    this.clips.push({ ...clip, key: this.nextKey++ } as PlannedClip);
    return true;
  }

  resolveAsset(slot: TemplateSlot, scope: Scope): MediaAssetInfo | null {
    const assetId = scope.slotAssets[slot.id];
    const where = `${scope.label}${slot.label}`;
    if (assetId === undefined) {
      if (!slot.optional) {
        this.missing.add(`${scope.label}${slot.id}`);
        this.warn("missing-slot", `"${where}" has no media; that part of the template is left empty.`);
      }
      return null;
    }
    const asset = this.assets.get(assetId);
    if (!asset) {
      this.warn("unknown-asset", `"${where}" points at asset "${assetId}", which is not in the project; that part of the template is left empty.`);
      if (!slot.optional) this.missing.add(`${scope.label}${slot.id}`);
      return null;
    }
    const compatible = slot.kind === "audio" ? asset.type === "audio" : isVisual(asset);
    if (!compatible) {
      this.warn("wrong-kind", `"${where}" needs ${slot.kind === "audio" ? "audio" : "a video or image"} but "${asset.name}" is ${asset.type}; it was not used.`);
      if (!slot.optional) this.missing.add(`${scope.label}${slot.id}`);
      return null;
    }
    return asset;
  }

  // ---- Media -------------------------------------------------------------------------------------------------

  planMedia(beat: TemplateBeat, startSeconds: number, scope: Scope): void {
    const media = beat.media;
    if (!media) return;
    const slot = scope.slots.get(media.slot);
    if (!slot) return;
    const asset = this.resolveAsset(slot, scope);
    if (!asset) return;
    const { start, duration } = this.span(startSeconds, beat.duration);
    const label = `${scope.label}${slot.label}`;
    if (asset.type === "audio") {
      this.planAudio({ asset, start, duration, media, label });
      return;
    }
    const framing = frameVisual({ asset, canvas: this.canvas, media });
    const placement = media.track === "overlay" || media.box ? "overlay" : "main";
    const common = {
      placement: placement as PlannedMedia["placement"], params: framing.params, muteSource: media.audio === "mute",
      ...(media.filter ? { filter: { preset: media.filter.preset, intensity: media.filter.intensity ?? 1 } } : {}),
      z: Z.media,
    };
    const transitionSeconds = media.transitionIn?.seconds ?? DEFAULT_TRANSITION_SECONDS;
    const transition = media.transitionIn ? { type: media.transitionIn.type, duration: this.tick(transitionSeconds) } : undefined;
    const keyframesFor = (d: MediaTime): PlannedKeyframe[] => {
      if (!media.pushIn) return [];
      const sx = Number(framing.params[PARAM.scaleX] ?? 1);
      const sy = Number(framing.params[PARAM.scaleY] ?? 1);
      const px = Number(framing.params[PARAM.positionX] ?? 0);
      const py = Number(framing.params[PARAM.positionY] ?? 0);
      const k = media.pushIn;
      return [
        { path: PARAM.scaleX, time: 0, value: sx }, { path: PARAM.scaleX, time: d, value: round3(sx * k) },
        { path: PARAM.scaleY, time: 0, value: sy }, { path: PARAM.scaleY, time: d, value: round3(sy * k) },
        ...(px !== 0 || py !== 0 ? [
          { path: PARAM.positionX, time: 0, value: px }, { path: PARAM.positionX, time: d, value: Math.round(px * k) },
          { path: PARAM.positionY, time: 0, value: py }, { path: PARAM.positionY, time: d, value: Math.round(py * k) },
        ] : []),
      ];
    };

    if (asset.type === "image") {
      this.push({
        type: "image", name: asset.name, assetId: asset.id, start, duration, trimStart: mediaTime(0), trimEnd: mediaTime(0),
        keyframes: keyframesFor(duration), ...common, ...(transition ? { transition } : {}),
      });
      return;
    }

    const sourceDuration = asset.duration ?? duration;
    const frame = frameDuration(this.fps);
    const sourceStartRequested = mediaTimeFromSeconds(media.sourceStart ?? 0);
    const base = { type: "video" as const, assetId: asset.id, name: asset.name, sourceDuration, ...common };

    if (sourceDuration >= duration) {
      const trimStart = mediaTime(Math.min(sourceStartRequested, sourceDuration - duration));
      this.push({
        ...base, start, duration, trimStart, trimEnd: mediaTime(sourceDuration - trimStart - duration),
        keyframes: keyframesFor(duration), ...(transition ? { transition } : {}),
      });
      return;
    }

    const policy: ShortMediaPolicy = media.onShort ?? "hold";
    const playable = floorToFrame(sourceDuration, this.fps);
    if (playable < frame) {
      this.warn("short-media", `${label} ("${asset.name}") is shorter than one frame; its first frame is held for the whole beat.`);
      this.push({
        type: "image", name: asset.name, assetId: asset.id, start, duration, trimStart: mediaTime(0), trimEnd: mediaTime(0),
        freezeAt: mediaTime(0), keyframes: keyframesFor(duration), ...common, ...(transition ? { transition } : {}),
      });
      return;
    }
    const seconds = round3(sourceDuration / TICKS_PER_SECOND);
    const beatSeconds = round3(beat.duration);
    if (policy === "shrink") {
      this.warn("short-media", `${label} ("${asset.name}") is ${seconds}s but the template wants ${beatSeconds}s; the beat ends early.`);
      this.push({ ...base, start, duration: playable, trimStart: mediaTime(0), trimEnd: mediaTime(sourceDuration - playable), keyframes: keyframesFor(playable), ...(transition ? { transition } : {}) });
      return;
    }
    if (policy === "loop" && Math.ceil(duration / playable) <= MAX_LOOP_COPIES) {
      this.warn("short-media", `${label} ("${asset.name}") is ${seconds}s but the template wants ${beatSeconds}s; it loops to fill the beat.`);
      let at = start;
      const end = start + duration;
      let first = true;
      while (at < end) {
        const length = mediaTime(Math.min(playable, end - at));
        this.push({
          ...base, start: at, duration: length, trimStart: mediaTime(0), trimEnd: mediaTime(sourceDuration - length),
          keyframes: [], ...(first && transition ? { transition } : {}),
        });
        first = false;
        at = mediaTime(at + length);
      }
      return;
    }
    this.warn("short-media", `${label} ("${asset.name}") is ${seconds}s but the template wants ${beatSeconds}s; its last frame is held to fill the beat.`);
    this.push({
      ...base, start, duration: playable, trimStart: mediaTime(0), trimEnd: mediaTime(sourceDuration - playable),
      keyframes: [], ...(transition ? { transition } : {}),
    });
    this.push({
      type: "image", name: `${asset.name} (hold)`, assetId: asset.id, start: mediaTime(start + playable), duration: mediaTime(duration - playable),
      trimStart: mediaTime(0), trimEnd: mediaTime(0), freezeAt: mediaTime(Math.max(0, sourceDuration - FREEZE_END_GUARD_TICKS)), keyframes: [], ...common,
    });
  }

  private planAudio(input: { asset: MediaAssetInfo; start: MediaTime; duration: MediaTime; media: MediaPlacement; label: string }): void {
    const { asset, start, media } = input;
    const sourceDuration = asset.duration ?? input.duration;
    const length = mediaTime(Math.min(input.duration, sourceDuration));
    if (length < frameDuration(this.fps)) {
      this.warn("short-media", `${input.label} ("${asset.name}") is too short to play and was left out.`);
      return;
    }
    if (length < input.duration) {
      this.warn("short-media", `${input.label} ("${asset.name}") is ${round3(sourceDuration / TICKS_PER_SECOND)}s but the template wants ${round3(input.duration / TICKS_PER_SECOND)}s; the audio ends early.`);
    }
    const trimStart = mediaTime(Math.min(mediaTimeFromSeconds(media.sourceStart ?? 0), sourceDuration - length));
    this.push({
      type: "audio", name: asset.name, assetId: asset.id, placement: "audio", start, duration: length, trimStart,
      trimEnd: mediaTime(sourceDuration - trimStart - length), sourceDuration, params: {}, muteSource: false, keyframes: [], z: Z.audio,
    });
  }

  // ---- Text and graphics ------------------------------------------------------------------------------------

  textContent(text: TemplateText, scope: Scope): string | null {
    const supplied = scope.textValues[text.id];
    if (supplied === undefined) return this.fillPlaceholders(text.default, scope);
    let content = supplied.replace(/\r\n?/g, "\n").trim();
    if (content.length === 0) return null;
    const limit = text.maxChars ?? TEMPLATE_LIMITS.maxTextChars;
    if (content.length > limit) {
      content = content.slice(0, limit).trimEnd();
      this.warn("text-truncated", `"${scope.label}${text.label}" was cut to ${limit} characters.`);
    }
    return content;
  }

  private fillPlaceholders(content: string, scope: Scope): string {
    return scope.item ? content.replaceAll("{n}", String(scope.item.n)).replaceAll("{count}", String(scope.item.count)) : content;
  }

  planText(layer: Extract<BeatLayer, { kind: "text" }>, beat: TemplateBeat, startSeconds: number, scope: Scope): void {
    const text = scope.texts.get(layer.text);
    if (!text) return;
    const content = this.textContent(text, scope);
    if (content === null) return;
    const preset = TEXT_STYLE_PRESETS[text.style];
    if (!preset) return;
    const { sizePx: overridePx, ...overrides } = (text.overrides ?? {}) as Record<string, number | string | boolean>;
    const params: ParamValues = { ...preset.params, ...overrides };
    this.pushText({
      name: text.label, content, sizePx: typeof overridePx === "number" ? overridePx : preset.sizePx, params,
      position: layer.position ?? { x: 0, y: 0 }, beatStart: startSeconds, beatDuration: beat.duration, at: layer.at ?? 0, duration: layer.duration,
      animation: layer.animation ?? text.animation, z: Z.text, where: `${scope.label}${text.label}`, maxWidth: text.maxWidth,
    });
  }

  pushText(input: {
    name: string; content: string; sizePx: number; params: ParamValues; position: { x: number; y: number }; beatStart: number; beatDuration: number;
    at: number; duration: number | undefined; animation: { in?: TextAnimationChoice; out?: TextAnimationChoice } | undefined; z: number; where: string;
    maxWidth?: number | undefined;
  }): void {
    const letterSpacing = typeof input.params[PARAM.letterSpacing] === "number" ? (input.params[PARAM.letterSpacing] as number) : 0;
    const padded = input.params[PARAM.bgEnabled] === true ? 0.82 : 1;
    const fit = fitText({ content: input.content, sizePx: input.sizePx, letterSpacing, maxWidth: (input.maxWidth ?? this.canvas.width * MAX_TEXT_WIDTH_RATIO) * padded });
    if (fit.shrunk) this.warn("text-shrunk", `"${input.where}" was made smaller so its longest word fits the frame.`);
    const startSeconds = input.beatStart + input.at;
    const length = Math.max(0.05, input.duration ?? input.beatDuration - input.at);
    const { start, duration } = this.span(startSeconds, length);
    const params: ParamValues = {
      ...input.params,
      [PARAM.content]: fit.content,
      [PARAM.fontSize]: round3((fit.sizePx * TEXT_SIZE_REFERENCE_HEIGHT) / this.canvas.height),
      [PARAM.positionX]: Math.round(input.position.x),
      [PARAM.positionY]: Math.round(input.position.y),
    };
    const limit = maxTextAnimationDuration(duration);
    const phase = (choice: TextAnimationChoice | undefined) =>
      choice && limit >= 1 ? { preset: choice.preset, duration: mediaTime(Math.max(1, Math.min(limit, this.tick(choice.seconds ?? DEFAULT_TEXT_ANIMATION_SECONDS)))) } : undefined;
    const animIn = phase(input.animation?.in);
    const animOut = phase(input.animation?.out);
    this.push({
      type: "text", name: input.name, start, duration, z: input.z, params,
      ...(animIn || animOut ? { animation: { ...(animIn ? { in: animIn } : {}), ...(animOut ? { out: animOut } : {}) } } : {}),
    });
  }

  planGraphic(layer: Extract<BeatLayer, { kind: "graphic" }>, beat: TemplateBeat, startSeconds: number): void {
    const at = layer.at ?? 0;
    const length = Math.max(0.05, layer.duration ?? beat.duration - at);
    const { start, duration } = this.span(startSeconds + at, length);
    const side = Math.min(this.canvas.width, this.canvas.height);
    const params: ParamValues = {
      ...(layer.params ?? {}),
      [PARAM.scaleX]: Math.max(0.01, round3(layer.box.width / side)),
      [PARAM.scaleY]: Math.max(0.01, round3(layer.box.height / side)),
      [PARAM.positionX]: Math.round(layer.box.x),
      [PARAM.positionY]: Math.round(layer.box.y),
    };
    this.push({ type: "graphic", name: layer.shape, shape: layer.shape, start, duration, z: Z.graphic, params });
  }

  planBeat(beat: TemplateBeat, startSeconds: number, scope: Scope): void {
    this.planMedia(beat, startSeconds, scope);
    for (const layer of beat.layers ?? []) {
      if (layer.kind === "text") this.planText(layer, beat, startSeconds, scope);
      else this.planGraphic(layer, beat, startSeconds);
    }
  }

  // ---- Captions ----------------------------------------------------------------------------------------------

  planCaptions(cues: ReadonlyArray<CaptionCueInput>): void {
    const styleId = this.template.captions?.style;
    const style = styleId ? CAPTION_STYLE_PRESETS[styleId] : undefined;
    if (!style) {
      this.warn("caption-skipped", "This template has no caption style, so the caption cues were not added.");
      return;
    }
    const preset = TEXT_STYLE_PRESETS[style.text];
    if (!preset) return;
    cues.forEach((cue, i) => {
      if (!(cue.end > cue.start) || cue.start < 0 || cue.text.trim().length === 0) {
        this.warn("caption-skipped", `Caption ${i + 1} has no usable time range or text and was skipped.`);
        return;
      }
      this.pushText({
        name: `Caption ${i + 1}`, content: cue.text.trim().slice(0, TEMPLATE_LIMITS.maxTextChars), sizePx: preset.sizePx, params: preset.params,
        position: { x: 0, y: Math.round(style.positionYRatio * this.canvas.height) }, beatStart: cue.start, beatDuration: cue.end - cue.start,
        at: 0, duration: undefined, animation: undefined, z: Z.caption, where: `Caption ${i + 1}`,
      });
    });
  }
}

function indexOf<T extends { id: string }>(list: ReadonlyArray<T>): Map<string, T> {
  return new Map(list.map((x) => [x.id, x]));
}

function itemCount(group: RepeatGroup, supplied: number, planner: Planner): number {
  if (supplied > group.max) {
    planner.warn("repeat-count", `"${group.label}" takes at most ${group.max} items; ${supplied - group.max} extra were left out.`);
    return group.max;
  }
  if (supplied < group.min) {
    if (supplied > 0) planner.warn("repeat-count", `"${group.label}" needs at least ${group.min} items; ${group.min - supplied} empty ${group.min - supplied === 1 ? "item was" : "items were"} added.`);
    return group.min;
  }
  return supplied;
}

/**
 * Turns a template and the user's media and words into a layout of clips: exact frame-snapped times, trims that keep
 * the source mapping intact, text and shape params, filters, transitions and keyframes. Pure: no editor, no ids.
 * Missing, short or wrong-kind media never throws; the affected part is left out or adjusted and a warning says so.
 */
export function planTemplate(input: { template: ProjectTemplate; inputs?: TemplateInputs; assets: ReadonlyArray<MediaAssetInfo> }): TemplatePlan {
  const { template } = input;
  const inputs = input.inputs ?? {};
  const planner = new Planner(template, input.assets);

  const topSlots = indexOf(template.slots);
  const topTexts = indexOf(template.texts);
  for (const key of Object.keys(inputs.slots ?? {})) {
    if (!topSlots.has(key)) planner.warn("unknown-input", `"${key}" is not a media slot of this template (slots: ${[...topSlots.keys()].join(", ") || "none"}).`);
  }
  for (const key of Object.keys(inputs.texts ?? {})) {
    if (!topTexts.has(key)) planner.warn("unknown-input", `"${key}" is not a text of this template (texts: ${[...topTexts.keys()].join(", ") || "none"}).`);
  }
  for (const key of Object.keys(inputs.repeat ?? {})) {
    if (!(template.repeat ?? []).some((g) => g.id === key)) planner.warn("unknown-input", `"${key}" is not a repeat group of this template.`);
  }

  const groupEnds = new Map<string, number>();
  for (const group of template.repeat ?? []) {
    const supplied = inputs.repeat?.[group.id] ?? [];
    const count = itemCount(group, supplied.length, planner);
    groupEnds.set(group.id, group.at + count * group.itemSeconds);
    const slots = indexOf(group.slots);
    const texts = indexOf(group.texts);
    for (let i = 0; i < count; i++) {
      const item = supplied[i] ?? {};
      const scope: Scope = {
        slots, texts, slotAssets: item.slots ?? {}, textValues: item.texts ?? {}, offset: group.at + i * group.itemSeconds, label: `${group.label} ${i + 1}: `,
        item: { n: i + 1, count },
      };
      for (const beat of group.beats) planner.planBeat(beat, scope.offset + beat.at, scope);
    }
  }

  const topScope: Scope = { slots: topSlots, texts: topTexts, slotAssets: inputs.slots ?? {}, textValues: inputs.texts ?? {}, offset: 0, label: "" };
  for (const beat of template.beats.filter((b) => !b.toEnd)) {
    const base = beat.afterRepeat ? (groupEnds.get(beat.afterRepeat) ?? 0) : 0;
    planner.planBeat(beat, base + beat.at, topScope);
  }
  const contentEnd = planner.clips.reduce((end, c) => Math.max(end, c.start + c.duration), 0) / TICKS_PER_SECOND;
  for (const beat of template.beats.filter((b) => b.toEnd)) {
    const length = contentEnd - beat.at;
    if (length >= 0.05) planner.planBeat({ ...beat, duration: length }, beat.at, topScope);
  }

  if (inputs.captionCues && inputs.captionCues.length > 0) planner.planCaptions(inputs.captionCues);

  const clips = layOutMain(planner.clips);
  const endTime = mediaTime(clips.reduce((end, c) => Math.max(end, c.start + c.duration), 0));
  return {
    templateId: template.id,
    canvas: planner.canvas,
    fps: planner.fps,
    ...(template.canvas.backgroundColor ? { backgroundColor: template.canvas.backgroundColor } : {}),
    clips,
    warnings: planner.warnings,
    missingSlots: [...planner.missing],
    endTime,
  };
}

/**
 * The editor pins the earliest main-track clip to t=0. When the template's main-track clips would not start there, they
 * go on an overlay track instead so nothing slides. Order is by layer, then time, then plan order.
 */
function layOutMain(clips: PlannedClip[]): PlannedClip[] {
  const mains = clips.filter((c): c is PlannedMedia => c.type !== "text" && c.type !== "graphic" && c.placement === "main");
  const firstMain = mains.reduce((min, c) => Math.min(min, c.start), Number.POSITIVE_INFINITY);
  const demote = mains.length > 0 && firstMain > PX_PER_CANVAS_EPSILON;
  return clips
    .map((c) => (demote && c.type !== "text" && c.type !== "graphic" && c.placement === "main" ? { ...c, placement: "overlay" as const } : c))
    .sort((a, b) => a.z - b.z || a.start - b.start || a.key - b.key);
}
