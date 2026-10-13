/**
 * Surplus Intelligence model catalog (`GET /v1/models`, public). Modality is `architecture.output_modalities`
 * (`image`, `video`, `music`, `audio`); the capability knobs are the `sizes`, `aspect_ratios`, `durations_seconds`
 * and `voices` arrays, and the price is `pricing.image` (USD per `pricing.media_unit`) when the catalog states one.
 */
export type GenerateKind = "image" | "video" | "music" | "speech";

export const GENERATE_KINDS: ReadonlyArray<{ id: GenerateKind; label: string; noun: string }> = [
  { id: "image", label: "Image", noun: "image" },
  { id: "video", label: "Video", noun: "video clip" },
  { id: "music", label: "Music", noun: "audio track" },
  { id: "speech", label: "Speech", noun: "voice-over" },
];

export type PriceUnit = "image" | "job" | "megapixel" | "1K characters";

export interface GenerateModel {
  id: string;
  name: string;
  kind: GenerateKind;
  /** USD per `priceUnit`, or undefined when the catalog does not state a price (token-metered models, some video). */
  price?: number;
  priceUnit?: PriceUnit;
  sizes: string[];
  aspectRatios: string[];
  durations: number[];
  voices: string[];
  legacy: boolean;
}

const OUTPUT_MODALITY: Readonly<Record<GenerateKind, string>> = { image: "image", video: "video", music: "music", speech: "audio" };
const PRICE_UNITS: ReadonlySet<string> = new Set<PriceUnit>(["image", "job", "megapixel", "1K characters"]);
/** Needs a source image or video, which this panel does not collect. */
const NEEDS_SOURCE_ID = /remover|upscale/i;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
const numbers = (v: unknown): number[] => (Array.isArray(v) ? v.filter((x): x is number => typeof x === "number" && Number.isFinite(x)) : []);

function kindOf(entry: Record<string, unknown>): GenerateKind | null {
  const architecture = isRecord(entry.architecture) ? entry.architecture : {};
  const outputs = strings(architecture.output_modalities);
  for (const kind of Object.keys(OUTPUT_MODALITY) as GenerateKind[]) {
    if (outputs.includes(OUTPUT_MODALITY[kind])) return kind;
  }
  return null;
}

/** True when the model can run from a text prompt alone: image edit, image-to-video, TTS-on-the-music-route and upscalers cannot. */
function runsFromPrompt(kind: GenerateKind, id: string, features: ReadonlyArray<string>): boolean {
  if (NEEDS_SOURCE_ID.test(id)) return false;
  const has = (f: string): boolean => features.includes(f);
  switch (kind) {
    case "image": return !has("image_edit") && !has("image-to-image");
    case "video": return has("text-to-video") || (!has("image-to-video") && !has("video-upscale"));
    case "music": return !has("lyrics_required") && !has("tts");
    case "speech": return true;
  }
}

function parseModel(entry: unknown): GenerateModel | null {
  if (!isRecord(entry) || typeof entry.id !== "string") return null;
  const kind = kindOf(entry);
  if (!kind) return null;
  const features = [...strings(entry.supported_features), ...strings(entry.supported_parameters)];
  if (!runsFromPrompt(kind, entry.id, features)) return null;
  const pricing = isRecord(entry.pricing) ? entry.pricing : {};
  const price = Number(pricing.image);
  const unit = typeof pricing.media_unit === "string" && PRICE_UNITS.has(pricing.media_unit) ? (pricing.media_unit as PriceUnit) : undefined;
  const priced = unit !== undefined && Number.isFinite(price) && price > 0;
  return {
    id: entry.id,
    name: typeof entry.name === "string" ? entry.name : entry.id,
    kind,
    ...(priced ? { price, priceUnit: unit } : {}),
    sizes: strings(entry.sizes),
    aspectRatios: strings(entry.aspect_ratios).filter((r) => r !== "auto"),
    durations: numbers(entry.durations_seconds),
    voices: strings(entry.voices),
    legacy: features.includes("legacy"),
  };
}

/** Cheapest priced first (models with no stated price last), then by name. */
const byPrice = (a: GenerateModel, b: GenerateModel): number => (a.price ?? Infinity) - (b.price ?? Infinity) || a.name.localeCompare(b.name);

/** Models usable from a prompt alone, grouped by kind. Entries that do not parse are dropped, never guessed at. */
export function parseCatalog(body: unknown): GenerateModel[] {
  const data = isRecord(body) && Array.isArray(body.data) ? body.data : [];
  return data.map(parseModel).filter((m): m is GenerateModel => m !== null);
}

export function modelsOfKind(models: ReadonlyArray<GenerateModel>, kind: GenerateKind): GenerateModel[] {
  return models.filter((m) => m.kind === kind && !m.legacy).sort(byPrice);
}

/** The cheapest model with a stated price, else the first listed. */
export function defaultModel(models: ReadonlyArray<GenerateModel>, kind: GenerateKind): GenerateModel | undefined {
  return modelsOfKind(models, kind)[0];
}

export function formatUsd(usd: number): string {
  if (usd >= 0.01) return `$${usd.toFixed(2)}`;
  return `$${usd.toFixed(4).replace(/0+$/, "")}`;
}

const UNIT_LABEL: Readonly<Record<PriceUnit, string>> = { image: "per image", job: "per job", megapixel: "per megapixel", "1K characters": "per 1,000 characters" };

/** Catalog price as a short hint, e.g. "$0.01 per image". Empty when the catalog states none. */
export function priceHint(model: GenerateModel): string {
  return model.price === undefined || model.priceUnit === undefined ? "" : `${formatUsd(model.price)} ${UNIT_LABEL[model.priceUnit]}`;
}

export interface CostEstimate {
  usd: number;
  /** True when the real charge can differ (resolution, duration or length scaling). */
  approximate: boolean;
}

const MEGAPIXELS_DEFAULT = 1.05;

function megapixels(size: string | undefined): number {
  const match = /^(\d+)x(\d+)$/.exec(size ?? "");
  return match ? (Number(match[1]) * Number(match[2])) / 1_000_000 : MEGAPIXELS_DEFAULT;
}

/**
 * Best estimate from the catalog alone, or null when it states no price. Jobs are quoted for the model's default length,
 * so video and music are approximate; the submit response carries the gateway's own quote and ceiling, which the
 * client reports as soon as it has them.
 */
export function estimateCost(input: { model: GenerateModel; size?: string; characters?: number }): CostEstimate | null {
  const { model } = input;
  if (model.price === undefined || model.priceUnit === undefined) return null;
  switch (model.priceUnit) {
    case "image": return { usd: model.price, approximate: false };
    case "megapixel": return { usd: model.price * megapixels(input.size), approximate: true };
    case "job": return { usd: model.price, approximate: true };
    case "1K characters": return { usd: (model.price * Math.max(1, input.characters ?? 0)) / 1000, approximate: true };
  }
}

export function describeEstimate(estimate: CostEstimate | null): string {
  return estimate === null ? "Price not listed in the catalog; the gateway quotes it when you submit." : `${estimate.approximate ? "About " : ""}${formatUsd(estimate.usd)}`;
}
