import {
  CROP_MAX_EDGE, FILTER_PRESET_IDS, TEXT_ANIMATION_PRESETS, TRANSITION_TYPES, buildGraphicElement,
  type FilterPresetId, type TextAnimationPreset, type TransitionType,
} from "#/engine/model";
import { ToolError } from "#/engine/agent/env";
import { mediaTime } from "#/engine/time";
import { paramSpecsFor, textSpecs, validateParamValues } from "#/engine/agent/params";
import { CAPTION_STYLE_PRESETS, TEXT_STYLE_PRESETS } from "./presets";
import {
  GRAPHIC_SHAPES, MEDIA_FIT, SHORT_MEDIA_POLICIES, SLOT_KINDS, TEMPLATE_ASPECTS, TEMPLATE_CATEGORIES, TEMPLATE_FORMAT, TEMPLATE_LIMITS,
  TEMPLATE_VERSION, TemplateValidationError,
  type BeatLayer, type Crop, type GraphicShape, type MediaFit, type MediaPlacement, type ParamOverrides, type PixelBox, type ProjectTemplate,
  type RepeatGroup, type ShortMediaPolicy, type SlotKind, type TemplateAspect, type TemplateBeat, type TemplateCategory, type TemplateIssue,
  type TemplateIssueCode, type TemplateSlot, type TemplateText, type TextAnimationChoice,
} from "./types";

const L = TEMPLATE_LIMITS;
const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,47}$/;
const HEX_COLOR = /^#(?:[0-9a-f]{6}|[0-9a-f]{8})$/i;
const PREVIEW_FILE = /^[a-z0-9][a-z0-9-]{0,63}\.(?:webp|mp4)$/;
/** C0 controls other than tab/newline, DEL, and the bidirectional override/isolate characters. */
// eslint-disable-next-line no-control-regex
const HOSTILE_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f‪-‮⁦-⁩]/;
const FORBIDDEN_KEYS: ReadonlySet<string> = new Set(["__proto__", "constructor", "prototype"]);
const MAX_SCANNED_NODES = 50_000;
const MAX_ABS_PIXELS = 20_000;
const GEOMETRY_KEYS: ReadonlySet<string> = new Set(["transform.positionX", "transform.positionY", "transform.scaleX", "transform.scaleY"]);

type Raw = Record<string, unknown>;

function isPlainObject(value: unknown): value is Raw {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
}

class Reader {
  readonly issues: TemplateIssue[] = [];

  add(code: TemplateIssueCode, path: string, message: string): void {
    if (this.issues.length < 50) this.issues.push({ code, path, message });
  }

  object(value: unknown, path: string, allowed: readonly string[]): Raw | null {
    if (!isPlainObject(value)) {
      this.add("not-an-object", path, "expected an object");
      return null;
    }
    const raw = value as Raw;
    for (const key of Object.keys(raw)) {
      if (!allowed.includes(key)) this.add(FORBIDDEN_KEYS.has(key) ? "forbidden-key" : "unknown-key", `${path}.${key}`, `"${key}" is not a template field here (allowed: ${allowed.join(", ")})`);
    }
    return raw;
  }

  array(value: unknown, path: string, max: number, options: { min?: number } = {}): unknown[] | null {
    if (!Array.isArray(value)) {
      this.add("wrong-type", path, "expected an array");
      return null;
    }
    if (value.length > max) {
      this.add("too-many", path, `at most ${max} entries are allowed, got ${value.length}`);
      return null;
    }
    if (options.min !== undefined && value.length < options.min) {
      this.add("empty", path, `at least ${options.min} entr${options.min === 1 ? "y" : "ies"} required`);
      return null;
    }
    return value;
  }

  string(value: unknown, path: string, options: { max: number; min?: number; multiline?: boolean; pattern?: RegExp; what?: string }): string | undefined {
    if (typeof value !== "string") {
      this.add(value === undefined ? "missing" : "wrong-type", path, value === undefined ? "required" : "expected a string");
      return undefined;
    }
    if (value.length > options.max) {
      this.add("too-long", path, `at most ${options.max} characters, got ${value.length}`);
      return undefined;
    }
    if (value.length < (options.min ?? 1)) {
      this.add("empty", path, "must not be empty");
      return undefined;
    }
    if (HOSTILE_CHARS.test(value) || (!options.multiline && value.includes("\n"))) {
      this.add("bad-value", path, "contains control or bidirectional-override characters");
      return undefined;
    }
    if (options.pattern && !options.pattern.test(value)) {
      this.add("bad-value", path, options.what ?? `does not match ${options.pattern.source}`);
      return undefined;
    }
    return value;
  }

  optString(raw: Raw, key: string, path: string, options: { max: number; multiline?: boolean }): string | undefined {
    return raw[key] === undefined ? undefined : this.string(raw[key], `${path}.${key}`, options);
  }

  number(value: unknown, path: string, options: { min: number; max: number; int?: boolean; exclusiveMin?: boolean }): number | undefined {
    if (typeof value !== "number") {
      this.add(value === undefined ? "missing" : "wrong-type", path, value === undefined ? "required" : "expected a number");
      return undefined;
    }
    if (!Number.isFinite(value) || (options.int && !Number.isInteger(value))) {
      this.add("bad-value", path, options.int ? "expected a finite integer" : "expected a finite number");
      return undefined;
    }
    if (value < options.min || value > options.max || (options.exclusiveMin && value <= options.min)) {
      this.add("out-of-range", path, `${value} is outside ${options.exclusiveMin ? ">" : ""}${options.min}..${options.max}`);
      return undefined;
    }
    return value;
  }

  optNumber(raw: Raw, key: string, path: string, options: { min: number; max: number; int?: boolean; exclusiveMin?: boolean }): number | undefined {
    return raw[key] === undefined ? undefined : this.number(raw[key], `${path}.${key}`, options);
  }

  oneOf<T extends string>(value: unknown, path: string, options: readonly T[]): T | undefined {
    if (typeof value !== "string" || !(options as readonly string[]).includes(value)) {
      this.add(value === undefined ? "missing" : "bad-value", path, `expected one of ${options.join(", ")}`);
      return undefined;
    }
    return value as T;
  }

  boolean(raw: Raw, key: string, path: string): boolean | undefined {
    const value = raw[key];
    if (value === undefined) return undefined;
    if (typeof value !== "boolean") {
      this.add("wrong-type", `${path}.${key}`, "expected true or false");
      return undefined;
    }
    return value;
  }
}

// ---- Pre-scan --------------------------------------------------------------------------------------------------

/** Depth, size and key checks that run before any field is read, so a hostile value never reaches the field readers. */
function scan(root: unknown, reader: Reader): boolean {
  const stack: Array<{ value: unknown; depth: number; path: string }> = [{ value: root, depth: 0, path: "" }];
  let nodes = 0;
  while (stack.length > 0) {
    const { value, depth, path } = stack.pop() as { value: unknown; depth: number; path: string };
    if (typeof value === "number" && !Number.isFinite(value)) {
      reader.add("bad-value", path, "numbers must be finite");
      return false;
    }
    if (typeof value === "function" || typeof value === "symbol" || typeof value === "bigint") {
      reader.add("wrong-type", path, "only JSON values are allowed");
      return false;
    }
    if (typeof value !== "object" || value === null) continue;
    if (++nodes > MAX_SCANNED_NODES) {
      reader.add("too-large", path, "too many values");
      return false;
    }
    if (depth > L.maxDepth) {
      reader.add("too-deep", path, `nesting is deeper than ${L.maxDepth}`);
      return false;
    }
    const entries = Array.isArray(value) ? value.map((v, i) => [String(i), v] as const) : Object.entries(value as Raw);
    for (const [key, inner] of entries) {
      if (FORBIDDEN_KEYS.has(key)) {
        reader.add("forbidden-key", `${path}.${key}`, `"${key}" is not allowed`);
        return false;
      }
      stack.push({ value: inner, depth: depth + 1, path: `${path}${Array.isArray(value) ? `[${key}]` : `.${key}`}` });
    }
  }
  return true;
}

// ---- Field groups ---------------------------------------------------------------------------------------------

function readId(reader: Reader, value: unknown, path: string): string | undefined {
  return reader.string(value, path, { max: L.maxIdLength, pattern: ID_PATTERN, what: "use lowercase letters, digits and hyphens (kebab-case)" });
}

function readOverrides(reader: Reader, value: unknown, path: string, check: (key: string, v: number | string | boolean) => string | null): ParamOverrides | undefined {
  if (!isPlainObject(value)) {
    reader.add("not-an-object", path, "expected an object");
    return undefined;
  }
  const raw = value;
  const out: ParamOverrides = {};
  const keys = Object.keys(raw);
  if (keys.length > 40) {
    reader.add("too-many", path, "at most 40 override keys");
    return undefined;
  }
  for (const key of keys) {
    const v = raw[key];
    if (typeof v !== "number" && typeof v !== "string" && typeof v !== "boolean") {
      reader.add("wrong-type", `${path}.${key}`, "expected a number, string or boolean");
      continue;
    }
    if (typeof v === "string" && (v.length > 64 || HOSTILE_CHARS.test(v))) {
      reader.add("bad-value", `${path}.${key}`, "string value is too long or contains control characters");
      continue;
    }
    const problem = check(key, v);
    if (problem) reader.add("bad-value", `${path}.${key}`, problem);
    else out[key] = v;
  }
  return out;
}

const TEXT_SPEC_BY_KEY = new Map(textSpecs().map((s) => [s.key, s]));
const SIZE_PX_LIMITS = { min: 8, max: 1200 };

function checkAgainstSpecs(specs: ReturnType<typeof textSpecs>, key: string, value: number | string | boolean): string | null {
  try {
    validateParamValues({ specs, values: { [key]: value }, subject: "template" });
    return null;
  } catch (error) {
    return error instanceof ToolError ? error.message : "invalid value";
  }
}

function readTextOverrides(reader: Reader, value: unknown, path: string): ParamOverrides | undefined {
  return readOverrides(reader, value, path, (key, v) => {
    if (key === "sizePx") return typeof v === "number" && v >= SIZE_PX_LIMITS.min && v <= SIZE_PX_LIMITS.max ? null : `sizePx must be a number ${SIZE_PX_LIMITS.min}-${SIZE_PX_LIMITS.max}`;
    if (key === "content") return "the text content comes from the template text, not from overrides";
    if (!TEXT_SPEC_BY_KEY.has(key)) return `"${key}" is not a text parameter (try sizePx, color, fontWeight, stroke.width, shadow.enabled, background.color, ...)`;
    return checkAgainstSpecs(textSpecs(), key, v);
  });
}

const graphicSpecs = (shape: GraphicShape) => paramSpecsFor(buildGraphicElement({ id: "x", startTime: mediaTime(0), definitionId: shape }));

function readGraphicParams(reader: Reader, value: unknown, path: string, shape: GraphicShape): ParamOverrides | undefined {
  const specs = graphicSpecs(shape);
  return readOverrides(reader, value, path, (key, v) => {
    if (GEOMETRY_KEYS.has(key)) return "size and position come from `box`";
    if (!specs.some((s) => s.key === key)) return `"${key}" is not a ${shape} parameter`;
    return checkAgainstSpecs(specs, key, v);
  });
}

function readAnimation(reader: Reader, value: unknown, path: string): { in?: TextAnimationChoice; out?: TextAnimationChoice } | undefined {
  const raw = reader.object(value, path, ["in", "out"]);
  if (!raw) return undefined;
  const out: { in?: TextAnimationChoice; out?: TextAnimationChoice } = {};
  for (const side of ["in", "out"] as const) {
    if (raw[side] === undefined) continue;
    const phase = reader.object(raw[side], `${path}.${side}`, ["preset", "seconds"]);
    if (!phase) continue;
    const preset = reader.oneOf<TextAnimationPreset>(phase["preset"], `${path}.${side}.preset`, TEXT_ANIMATION_PRESETS);
    const seconds = reader.optNumber(phase, "seconds", `${path}.${side}`, { min: 0.05, max: 10 });
    if (preset) out[side] = seconds === undefined ? { preset } : { preset, seconds };
  }
  return out;
}

function readSlot(reader: Reader, value: unknown, path: string): TemplateSlot | undefined {
  const raw = reader.object(value, path, ["id", "kind", "label", "hint", "optional", "expectedSeconds", "aspect"]);
  if (!raw) return undefined;
  const id = readId(reader, raw["id"], `${path}.id`);
  const kind = reader.oneOf<SlotKind>(raw["kind"], `${path}.kind`, SLOT_KINDS);
  const label = reader.string(raw["label"], `${path}.label`, { max: L.maxLabelLength });
  const hint = reader.optString(raw, "hint", path, { max: L.maxDescriptionLength });
  const optional = reader.boolean(raw, "optional", path);
  const expectedSeconds = reader.optNumber(raw, "expectedSeconds", path, { min: 0.1, max: L.maxSeconds });
  const aspect = raw["aspect"] === undefined ? undefined : reader.oneOf<TemplateAspect>(raw["aspect"], `${path}.aspect`, TEMPLATE_ASPECTS);
  if (!id || !kind || !label) return undefined;
  return { id, kind, label, ...(hint ? { hint } : {}), ...(optional ? { optional } : {}), ...(expectedSeconds !== undefined ? { expectedSeconds } : {}), ...(aspect ? { aspect } : {}) };
}

function readText(reader: Reader, value: unknown, path: string): TemplateText | undefined {
  const raw = reader.object(value, path, ["id", "label", "default", "maxChars", "maxWidth", "style", "overrides", "animation"]);
  if (!raw) return undefined;
  const id = readId(reader, raw["id"], `${path}.id`);
  const label = reader.string(raw["label"], `${path}.label`, { max: L.maxLabelLength });
  const maxChars = reader.optNumber(raw, "maxChars", path, { min: 1, max: L.maxTextChars, int: true });
  const maxWidth = reader.optNumber(raw, "maxWidth", path, { min: 100, max: MAX_ABS_PIXELS });
  const fallback = reader.string(raw["default"], `${path}.default`, { max: maxChars ?? L.maxTextChars, multiline: true });
  const style = reader.oneOf(raw["style"], `${path}.style`, Object.keys(TEXT_STYLE_PRESETS));
  const overrides = raw["overrides"] === undefined ? undefined : readTextOverrides(reader, raw["overrides"], `${path}.overrides`);
  const animation = raw["animation"] === undefined ? undefined : readAnimation(reader, raw["animation"], `${path}.animation`);
  if (!id || !label || fallback === undefined || !style) return undefined;
  return { id, label, default: fallback, ...(maxChars !== undefined ? { maxChars } : {}), ...(maxWidth !== undefined ? { maxWidth } : {}), style, ...(overrides ? { overrides } : {}), ...(animation ? { animation } : {}) };
}

function readBox(reader: Reader, value: unknown, path: string): PixelBox | undefined {
  const raw = reader.object(value, path, ["x", "y", "width", "height"]);
  if (!raw) return undefined;
  const x = reader.number(raw["x"], `${path}.x`, { min: -MAX_ABS_PIXELS, max: MAX_ABS_PIXELS });
  const y = reader.number(raw["y"], `${path}.y`, { min: -MAX_ABS_PIXELS, max: MAX_ABS_PIXELS });
  const width = reader.number(raw["width"], `${path}.width`, { min: 1, max: MAX_ABS_PIXELS });
  const height = reader.number(raw["height"], `${path}.height`, { min: 1, max: MAX_ABS_PIXELS });
  return x === undefined || y === undefined || width === undefined || height === undefined ? undefined : { x, y, width, height };
}

function readCrop(reader: Reader, value: unknown, path: string): Crop | undefined {
  const raw = reader.object(value, path, ["left", "top", "right", "bottom"]);
  if (!raw) return undefined;
  const crop: Crop = {};
  for (const side of ["left", "top", "right", "bottom"] as const) {
    const v = reader.optNumber(raw, side, path, { min: 0, max: CROP_MAX_EDGE });
    if (v !== undefined) crop[side] = v;
  }
  if ((crop.left ?? 0) + (crop.right ?? 0) > CROP_MAX_EDGE || (crop.top ?? 0) + (crop.bottom ?? 0) > CROP_MAX_EDGE) {
    reader.add("out-of-range", path, `opposite crop edges may remove at most ${CROP_MAX_EDGE} together`);
  }
  return crop;
}

function readMedia(reader: Reader, value: unknown, path: string, slots: ReadonlyMap<string, TemplateSlot>): MediaPlacement | undefined {
  const raw = reader.object(value, path, ["slot", "track", "fit", "crop", "zoom", "pushIn", "filter", "transitionIn", "onShort", "sourceStart", "audio", "box"]);
  if (!raw) return undefined;
  const slotId = readId(reader, raw["slot"], `${path}.slot`);
  const slot = slotId ? slots.get(slotId) : undefined;
  if (slotId && !slot) reader.add("unknown-ref", `${path}.slot`, `no slot "${slotId}" in this scope (slots: ${[...slots.keys()].join(", ") || "none"})`);
  if (!slotId) return undefined;
  const media: MediaPlacement = { slot: slotId };
  if (raw["track"] !== undefined) {
    const track = reader.oneOf<"main" | "overlay">(raw["track"], `${path}.track`, ["main", "overlay"]);
    if (track) media.track = track;
  }
  if (raw["fit"] !== undefined) {
    const fit = reader.oneOf<MediaFit>(raw["fit"], `${path}.fit`, MEDIA_FIT);
    if (fit) media.fit = fit;
  }
  if (raw["crop"] !== undefined) {
    const crop = readCrop(reader, raw["crop"], `${path}.crop`);
    if (crop) media.crop = crop;
  }
  if (raw["zoom"] !== undefined) {
    const zoom = reader.object(raw["zoom"], `${path}.zoom`, ["scale", "x", "y"]);
    if (zoom) {
      const scale = reader.number(zoom["scale"], `${path}.zoom.scale`, { min: 1, max: 6 });
      const x = reader.optNumber(zoom, "x", `${path}.zoom`, { min: -MAX_ABS_PIXELS, max: MAX_ABS_PIXELS });
      const y = reader.optNumber(zoom, "y", `${path}.zoom`, { min: -MAX_ABS_PIXELS, max: MAX_ABS_PIXELS });
      if (scale !== undefined) media.zoom = { scale, ...(x !== undefined ? { x } : {}), ...(y !== undefined ? { y } : {}) };
    }
  }
  const pushIn = reader.optNumber(raw, "pushIn", path, { min: 1, max: 3 });
  if (pushIn !== undefined) media.pushIn = pushIn;
  if (raw["filter"] !== undefined) {
    const filter = reader.object(raw["filter"], `${path}.filter`, ["preset", "intensity"]);
    if (filter) {
      const preset = reader.oneOf<FilterPresetId>(filter["preset"], `${path}.filter.preset`, FILTER_PRESET_IDS);
      const intensity = reader.optNumber(filter, "intensity", `${path}.filter`, { min: 0, max: 1 });
      if (preset) media.filter = intensity === undefined ? { preset } : { preset, intensity };
    }
  }
  if (raw["transitionIn"] !== undefined) {
    const t = reader.object(raw["transitionIn"], `${path}.transitionIn`, ["type", "seconds"]);
    if (t) {
      const type = reader.oneOf<TransitionType>(t["type"], `${path}.transitionIn.type`, TRANSITION_TYPES);
      const seconds = reader.optNumber(t, "seconds", `${path}.transitionIn`, { min: 0.04, max: 5 });
      if (type) media.transitionIn = seconds === undefined ? { type } : { type, seconds };
    }
  }
  if (raw["onShort"] !== undefined) {
    const policy = reader.oneOf<ShortMediaPolicy>(raw["onShort"], `${path}.onShort`, SHORT_MEDIA_POLICIES);
    if (policy) media.onShort = policy;
  }
  const sourceStart = reader.optNumber(raw, "sourceStart", path, { min: 0, max: L.maxSeconds });
  if (sourceStart !== undefined) media.sourceStart = sourceStart;
  if (raw["audio"] !== undefined) {
    const audio = reader.oneOf<"keep" | "mute">(raw["audio"], `${path}.audio`, ["keep", "mute"]);
    if (audio) media.audio = audio;
  }
  if (raw["box"] !== undefined) {
    const box = readBox(reader, raw["box"], `${path}.box`);
    if (box) media.box = box;
  }
  if (slot?.kind === "audio") {
    const visual = ["fit", "crop", "zoom", "pushIn", "filter", "transitionIn", "box", "track"].filter((k) => raw[k] !== undefined);
    if (visual.length > 0) reader.add("kind-mismatch", path, `slot "${slotId}" is audio, so ${visual.join(", ")} do not apply`);
  }
  if (slot?.kind === "image" && (raw["onShort"] !== undefined || raw["sourceStart"] !== undefined || raw["audio"] !== undefined)) {
    reader.add("kind-mismatch", path, `slot "${slotId}" is an image, so onShort, sourceStart and audio do not apply`);
  }
  if (media.track === "main" && media.box) reader.add("kind-mismatch", `${path}.box`, "a boxed clip is an overlay; set track to overlay");
  return media;
}

function readLayer(reader: Reader, value: unknown, path: string, texts: ReadonlyMap<string, TemplateText>, beatSeconds: number | undefined): BeatLayer | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    reader.add("not-an-object", path, "expected an object");
    return undefined;
  }
  const kind = (value as Raw)["kind"];
  const timing = (raw: Raw): { at?: number; duration?: number } => {
    const at = reader.optNumber(raw, "at", path, { min: 0, max: L.maxSeconds });
    const duration = reader.optNumber(raw, "duration", path, { min: 0.05, max: L.maxSeconds });
    if (at !== undefined && beatSeconds !== undefined && at >= beatSeconds) reader.add("out-of-range", `${path}.at`, `${at}s is not inside the ${beatSeconds}s beat`);
    return { ...(at !== undefined ? { at } : {}), ...(duration !== undefined ? { duration } : {}) };
  };
  if (kind === "text") {
    const raw = reader.object(value, path, ["kind", "text", "at", "duration", "position", "animation"]);
    if (!raw) return undefined;
    const text = readId(reader, raw["text"], `${path}.text`);
    if (text && !texts.has(text)) reader.add("unknown-ref", `${path}.text`, `no text "${text}" in this scope (texts: ${[...texts.keys()].join(", ") || "none"})`);
    let position: { x: number; y: number } | undefined;
    if (raw["position"] !== undefined) {
      const p = reader.object(raw["position"], `${path}.position`, ["x", "y"]);
      const x = p ? reader.number(p["x"], `${path}.position.x`, { min: -MAX_ABS_PIXELS, max: MAX_ABS_PIXELS }) : undefined;
      const y = p ? reader.number(p["y"], `${path}.position.y`, { min: -MAX_ABS_PIXELS, max: MAX_ABS_PIXELS }) : undefined;
      if (x !== undefined && y !== undefined) position = { x, y };
    }
    const animation = raw["animation"] === undefined ? undefined : readAnimation(reader, raw["animation"], `${path}.animation`);
    if (!text) return undefined;
    return { kind: "text", text, ...timing(raw), ...(position ? { position } : {}), ...(animation ? { animation } : {}) };
  }
  if (kind === "graphic") {
    const raw = reader.object(value, path, ["kind", "shape", "at", "duration", "box", "params"]);
    if (!raw) return undefined;
    const shape = reader.oneOf<GraphicShape>(raw["shape"], `${path}.shape`, GRAPHIC_SHAPES);
    const box = readBox(reader, raw["box"], `${path}.box`);
    const params = shape && raw["params"] !== undefined ? readGraphicParams(reader, raw["params"], `${path}.params`, shape) : undefined;
    if (!shape || !box) return undefined;
    return { kind: "graphic", shape, box, ...timing(raw), ...(params ? { params } : {}) };
  }
  reader.add(kind === undefined ? "missing" : "bad-value", `${path}.kind`, "expected \"text\" or \"graphic\"");
  return undefined;
}

function readBeat(
  reader: Reader, value: unknown, path: string,
  scope: { slots: ReadonlyMap<string, TemplateSlot>; texts: ReadonlyMap<string, TemplateText>; groups: ReadonlySet<string> | null; maxEnd: number },
): TemplateBeat | undefined {
  const raw = reader.object(value, path, ["id", "at", "duration", "afterRepeat", "toEnd", "media", "layers"]);
  if (!raw) return undefined;
  const id = readId(reader, raw["id"], `${path}.id`);
  const at = reader.number(raw["at"], `${path}.at`, { min: 0, max: L.maxSeconds });
  const duration = reader.number(raw["duration"], `${path}.duration`, { min: 0.05, max: L.maxSeconds });
  let afterRepeat: string | undefined;
  if (raw["afterRepeat"] !== undefined) {
    if (!scope.groups) reader.add("bad-value", `${path}.afterRepeat`, "only top-level beats can follow a repeat group");
    else {
      afterRepeat = readId(reader, raw["afterRepeat"], `${path}.afterRepeat`);
      if (afterRepeat && !scope.groups.has(afterRepeat)) reader.add("unknown-ref", `${path}.afterRepeat`, `no repeat group "${afterRepeat}"`);
    }
  }
  const toEnd = reader.boolean(raw, "toEnd", path);
  if (toEnd && !scope.groups) reader.add("bad-value", `${path}.toEnd`, "only top-level beats can run to the end");
  if (at !== undefined && duration !== undefined && !afterRepeat && !toEnd && at + duration > scope.maxEnd + 1e-9) {
    reader.add("out-of-range", path, `the beat ends at ${(at + duration).toFixed(2)}s, past ${scope.maxEnd}s`);
  }
  const media = raw["media"] === undefined ? undefined : readMedia(reader, raw["media"], `${path}.media`, scope.slots);
  let layers: BeatLayer[] | undefined;
  if (raw["layers"] !== undefined) {
    const list = reader.array(raw["layers"], `${path}.layers`, L.maxLayersPerBeat);
    if (list) layers = list.flatMap((layer, i) => readLayer(reader, layer, `${path}.layers[${i}]`, scope.texts, duration) ?? []);
  }
  if (!media && (!layers || layers.length === 0)) reader.add("empty", path, "a beat needs media or at least one layer");
  if (!id || at === undefined || duration === undefined) return undefined;
  return { id, at, duration, ...(afterRepeat ? { afterRepeat } : {}), ...(toEnd ? { toEnd } : {}), ...(media ? { media } : {}), ...(layers && layers.length > 0 ? { layers } : {}) };
}

function readScope<T extends { id: string }>(
  reader: Reader, value: unknown, path: string, max: number, read: (v: unknown, p: string) => T | undefined,
): { list: T[]; byId: Map<string, T> } {
  const list: T[] = [];
  const byId = new Map<string, T>();
  const raw = value === undefined ? [] : reader.array(value, path, max);
  (raw ?? []).forEach((entry, i) => {
    const item = read(entry, `${path}[${i}]`);
    if (!item) return;
    if (byId.has(item.id)) reader.add("duplicate-id", `${path}[${i}].id`, `"${item.id}" is used twice`);
    else {
      byId.set(item.id, item);
      list.push(item);
    }
  });
  return { list, byId };
}

function readGroup(reader: Reader, value: unknown, path: string): RepeatGroup | undefined {
  const raw = reader.object(value, path, ["id", "label", "min", "max", "at", "itemSeconds", "slots", "texts", "beats"]);
  if (!raw) return undefined;
  const id = readId(reader, raw["id"], `${path}.id`);
  const label = reader.string(raw["label"], `${path}.label`, { max: L.maxLabelLength });
  const min = reader.number(raw["min"], `${path}.min`, { min: 1, max: L.maxRepeatItems, int: true });
  const max = reader.number(raw["max"], `${path}.max`, { min: 1, max: L.maxRepeatItems, int: true });
  if (min !== undefined && max !== undefined && min > max) reader.add("out-of-range", `${path}.min`, "min must not exceed max");
  const at = reader.number(raw["at"], `${path}.at`, { min: 0, max: L.maxSeconds });
  const itemSeconds = reader.number(raw["itemSeconds"], `${path}.itemSeconds`, { min: 0.2, max: L.maxSeconds });
  const slots = readScope(reader, raw["slots"], `${path}.slots`, L.maxSlots, (v, p) => readSlot(reader, v, p));
  const texts = readScope(reader, raw["texts"], `${path}.texts`, L.maxTexts, (v, p) => readText(reader, v, p));
  const beatsRaw = reader.array(raw["beats"], `${path}.beats`, L.maxBeats, { min: 1 });
  const beats: TemplateBeat[] = [];
  const beatIds = new Set<string>();
  (beatsRaw ?? []).forEach((b, i) => {
    const beat = readBeat(reader, b, `${path}.beats[${i}]`, { slots: slots.byId, texts: texts.byId, groups: null, maxEnd: itemSeconds ?? L.maxSeconds });
    if (!beat) return;
    if (beatIds.has(beat.id)) reader.add("duplicate-id", `${path}.beats[${i}].id`, `"${beat.id}" is used twice`);
    beatIds.add(beat.id);
    beats.push(beat);
  });
  if (at !== undefined && itemSeconds !== undefined && max !== undefined && at + itemSeconds * max > L.maxSeconds) {
    reader.add("out-of-range", path, `${max} items of ${itemSeconds}s from ${at}s run past ${L.maxSeconds}s`);
  }
  if (!id || !label || min === undefined || max === undefined || at === undefined || itemSeconds === undefined) return undefined;
  return { id, label, min, max, at, itemSeconds, slots: slots.list, texts: texts.list, beats };
}

// ---- Entry points ---------------------------------------------------------------------------------------------

export type TemplateParseResult = { ok: true; template: ProjectTemplate } | { ok: false; issues: TemplateIssue[] };

function readTemplate(input: unknown, reader: Reader): ProjectTemplate | undefined {
  const raw = reader.object(input, "", [
    "format", "templateVersion", "id", "name", "description", "category", "tags", "canvas", "durationSeconds", "slots", "texts", "beats", "repeat", "captions", "preview",
  ]);
  if (!raw) return undefined;
  if (raw["format"] !== TEMPLATE_FORMAT) reader.add("bad-value", ".format", `expected "${TEMPLATE_FORMAT}"`);
  if (raw["templateVersion"] !== TEMPLATE_VERSION) {
    reader.add("unsupported-version", ".templateVersion", `this build reads templateVersion ${TEMPLATE_VERSION}, got ${JSON.stringify(raw["templateVersion"])}`);
    return undefined;
  }
  const id = readId(reader, raw["id"], ".id");
  const name = reader.string(raw["name"], ".name", { max: L.maxLabelLength });
  const description = reader.string(raw["description"], ".description", { max: L.maxDescriptionLength });
  const category = reader.oneOf<TemplateCategory>(raw["category"], ".category", TEMPLATE_CATEGORIES);
  const tags: string[] = [];
  for (const [i, tag] of (raw["tags"] === undefined ? [] : (reader.array(raw["tags"], ".tags", L.maxTags) ?? [])).entries()) {
    const t = reader.string(tag, `.tags[${i}]`, { max: 24, pattern: ID_PATTERN, what: "use lowercase letters, digits and hyphens" });
    if (t) tags.push(t);
  }

  const canvasRaw = reader.object(raw["canvas"], ".canvas", ["aspect", "fps", "backgroundColor"]);
  const aspect = canvasRaw ? reader.oneOf<TemplateAspect>(canvasRaw["aspect"], ".canvas.aspect", TEMPLATE_ASPECTS) : undefined;
  const fps = canvasRaw ? reader.number(canvasRaw["fps"], ".canvas.fps", { min: 12, max: 60 }) : undefined;
  let backgroundColor: string | undefined;
  if (canvasRaw?.["backgroundColor"] !== undefined) {
    backgroundColor = reader.string(canvasRaw["backgroundColor"], ".canvas.backgroundColor", { max: 9, pattern: HEX_COLOR, what: "expected #rrggbb" });
  }
  const durationSeconds = reader.number(raw["durationSeconds"], ".durationSeconds", { min: 1, max: L.maxSeconds });

  const slots = readScope(reader, raw["slots"], ".slots", L.maxSlots, (v, p) => readSlot(reader, v, p));
  const texts = readScope(reader, raw["texts"], ".texts", L.maxTexts, (v, p) => readText(reader, v, p));

  const groups: RepeatGroup[] = [];
  if (raw["repeat"] !== undefined) {
    for (const [i, g] of (reader.array(raw["repeat"], ".repeat", L.maxRepeatGroups) ?? []).entries()) {
      const group = readGroup(reader, g, `.repeat[${i}]`);
      if (!group) continue;
      if (groups.some((x) => x.id === group.id)) reader.add("duplicate-id", `.repeat[${i}].id`, `"${group.id}" is used twice`);
      else groups.push(group);
    }
  }

  const beatsRaw = reader.array(raw["beats"], ".beats", L.maxBeats, { min: groups.length > 0 ? 0 : 1 });
  const beats: TemplateBeat[] = [];
  const beatIds = new Set<string>();
  const groupIds = new Set(groups.map((g) => g.id));
  (beatsRaw ?? []).forEach((b, i) => {
    const beat = readBeat(reader, b, `.beats[${i}]`, { slots: slots.byId, texts: texts.byId, groups: groupIds, maxEnd: L.maxSeconds });
    if (!beat) return;
    if (beatIds.has(beat.id)) reader.add("duplicate-id", `.beats[${i}].id`, `"${beat.id}" is used twice`);
    beatIds.add(beat.id);
    beats.push(beat);
  });

  const planned = beats.reduce((n, b) => n + 1 + (b.layers?.length ?? 0), 0)
    + groups.reduce((n, g) => n + g.max * g.beats.reduce((m, b) => m + 1 + (b.layers?.length ?? 0), 0), 0);
  if (planned > L.maxPlannedElements) reader.add("too-many", "", `the template would create ${planned} clips; the limit is ${L.maxPlannedElements}`);

  let captions: ProjectTemplate["captions"];
  if (raw["captions"] !== undefined) {
    const c = reader.object(raw["captions"], ".captions", ["style"]);
    const style = c ? reader.oneOf(c["style"], ".captions.style", Object.keys(CAPTION_STYLE_PRESETS)) : undefined;
    if (style) captions = { style };
  }
  let preview: ProjectTemplate["preview"];
  if (raw["preview"] !== undefined) {
    const p = reader.object(raw["preview"], ".preview", ["poster", "video"]);
    const poster = p ? reader.string(p["poster"], ".preview.poster", { max: 72, pattern: PREVIEW_FILE, what: "a plain file name ending in .webp" }) : undefined;
    const video = p ? reader.string(p["video"], ".preview.video", { max: 72, pattern: PREVIEW_FILE, what: "a plain file name ending in .mp4" }) : undefined;
    if (poster && video) {
      if (!poster.endsWith(".webp")) reader.add("bad-value", ".preview.poster", "must be a .webp file");
      if (!video.endsWith(".mp4")) reader.add("bad-value", ".preview.video", "must be a .mp4 file");
      preview = { poster, video };
    }
  }

  if (!id || !name || !description || !category || !aspect || fps === undefined || durationSeconds === undefined) return undefined;
  return {
    format: TEMPLATE_FORMAT, templateVersion: TEMPLATE_VERSION, id, name, description, category, tags,
    canvas: { aspect, fps, ...(backgroundColor ? { backgroundColor } : {}) },
    durationSeconds, slots: slots.list, texts: texts.list, beats,
    ...(groups.length > 0 ? { repeat: groups } : {}), ...(captions ? { captions } : {}), ...(preview ? { preview } : {}),
  };
}

/** Validates an already-parsed value. Never throws; the template it returns is a fresh object containing only known fields. */
export function safeParseTemplate(input: unknown): TemplateParseResult {
  const reader = new Reader();
  try {
    if (scan(input, reader)) {
      const template = readTemplate(input, reader);
      if (template && reader.issues.length === 0) return { ok: true, template };
    }
  } catch (error) {
    reader.add("bad-value", "", `the value could not be read: ${error instanceof Error ? error.message : "unreadable"}`);
  }
  return { ok: false, issues: reader.issues.length > 0 ? reader.issues : [{ code: "bad-value", path: "", message: "not a valid template" }] };
}

export function parseTemplate(input: unknown): ProjectTemplate {
  const result = safeParseTemplate(input);
  if (!result.ok) throw new TemplateValidationError(result.issues);
  return result.template;
}

/** Parses user-supplied JSON text: size-capped, then validated like any other value. */
export function parseTemplateJson(text: string): ProjectTemplate {
  const bytes = new TextEncoder().encode(text).length;
  if (bytes > TEMPLATE_LIMITS.maxBytes) {
    throw new TemplateValidationError([{ code: "too-large", path: "", message: `${bytes} bytes exceeds the ${TEMPLATE_LIMITS.maxBytes} byte limit` }]);
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new TemplateValidationError([{ code: "not-json", path: "", message: error instanceof Error ? error.message : "not valid JSON" }]);
  }
  return parseTemplate(value);
}
