import type { GeneratedProvenance, MediaAssetInfo } from "#/engine/model";
import {
  GENERATE_KIND_PREF, GENERATE_MODELS_PREF, SURPLUS_API_KEY_PREF, isRecordOfStrings, isString, type PrefsStore,
} from "#/platform/prefs";
import { getServices, type ImportOutcome } from "../services";
import { Store } from "../store";
import {
  GENERATE_KINDS, defaultModel, estimateCost, modelsOfKind, type CostEstimate, type GenerateKind, type GenerateModel,
} from "./catalog";
import {
  GenerateError, checkSurplusKey, fetchCatalog, generateMedia, type GeneratedMedia, type GenerateProgress, type GenerateRequest, type SurplusKeyCheck,
} from "./client";

export const CATALOG_TTL_MS = 10 * 60_000;
/** The most a single agent-initiated generation may be expected to cost without the user pressing Generate themselves. */
export const AGENT_MAX_ESTIMATED_USD = 1;
export const PROVIDER_NAME = "Surplus Intelligence";

export type CatalogState =
  | { status: "idle" | "loading"; models: GenerateModel[] }
  | { status: "ready"; models: GenerateModel[]; fetchedAt: number }
  | { status: "error"; models: GenerateModel[]; message: string };

export interface GenerateJob {
  kind: GenerateKind;
  prompt: string;
  modelName: string;
  progress: GenerateProgress;
}

export interface GenerateResultInfo {
  assetId: string;
  name: string;
  kind: GenerateKind;
  quotedUsd?: number;
  chargedUsd?: number;
}

export interface GenerateState {
  apiKey: string;
  kind: GenerateKind;
  /** Chosen model id per kind; falls back to the catalog default when absent or no longer listed. */
  chosen: Readonly<Record<string, string>>;
  catalog: CatalogState;
  job: GenerateJob | null;
  result: GenerateResultInfo | null;
  error: string | null;
}

export type RunOutcome =
  | { ok: true; asset: MediaAssetInfo; media: GeneratedMedia }
  | { ok: false; error: string; code: GenerateError["code"] | "busy" | "no-project" | "import" };

export interface GenerateServiceDeps {
  prefs: PrefsStore;
  fetch?: typeof fetch;
  now?: () => number;
  hasProject: () => boolean;
  importFile: (file: File, generated: GeneratedProvenance) => Promise<ImportOutcome>;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

const isKind = (v: unknown): v is GenerateKind => isString(v) && GENERATE_KINDS.some((k) => k.id === v);

function fileName(media: GeneratedMedia): string {
  const slug = media.prompt.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32) || media.kind;
  return `generated-${slug}.${media.extension}`;
}

/**
 * Owns the Surplus key, the cached model catalog and the single running generation. The Generate panel and the agent's
 * `generate_media` tool both go through `run`, so there is one place that spends the user's credits and one that imports the result.
 */
export class GenerateService {
  readonly state: Store<GenerateState>;
  private controller: AbortController | null = null;
  private catalogLoad: Promise<void> | null = null;

  constructor(private readonly deps: GenerateServiceDeps) {
    this.state = new Store<GenerateState>({
      apiKey: deps.prefs.read(SURPLUS_API_KEY_PREF, "", isString),
      kind: deps.prefs.read(GENERATE_KIND_PREF, "image", isKind),
      chosen: deps.prefs.read(GENERATE_MODELS_PREF, {}, isRecordOfStrings),
      catalog: { status: "idle", models: [] },
      job: null, result: null, error: null,
    });
  }

  get hasKey(): boolean {
    return this.state.get().apiKey !== "";
  }

  setApiKey(apiKey: string): void {
    const trimmed = apiKey.trim();
    this.deps.prefs.write(SURPLUS_API_KEY_PREF, trimmed);
    this.state.set({ apiKey: trimmed, error: null });
  }

  forgetKey(): void {
    this.cancel();
    this.setApiKey("");
  }

  testKey(signal?: AbortSignal): Promise<SurplusKeyCheck> {
    return checkSurplusKey({ apiKey: this.state.get().apiKey, ...this.net(signal) });
  }

  setKind(kind: GenerateKind): void {
    this.deps.prefs.write(GENERATE_KIND_PREF, kind);
    this.state.set({ kind, error: null });
  }

  setModel(kind: GenerateKind, modelId: string): void {
    const chosen = { ...this.state.get().chosen, [kind]: modelId };
    this.deps.prefs.write(GENERATE_MODELS_PREF, chosen);
    this.state.set({ chosen });
  }

  /** The catalog is public and cached for ten minutes; `force` reloads it. Failures are kept in state, never thrown. */
  loadCatalog(options: { force?: boolean; signal?: AbortSignal } = {}): Promise<void> {
    const { catalog } = this.state.get();
    const now = (this.deps.now ?? Date.now)();
    if (!options.force && catalog.status === "ready" && now - catalog.fetchedAt < CATALOG_TTL_MS) return Promise.resolve();
    if (this.catalogLoad) return this.catalogLoad;
    this.state.set((s) => ({ catalog: { status: "loading", models: s.catalog.models } }));
    this.catalogLoad = fetchCatalog(this.net(options.signal))
      .then((models) => this.state.set({ catalog: { status: "ready", models, fetchedAt: (this.deps.now ?? Date.now)() } }))
      .catch((error: unknown) => this.state.set((s) => ({
        catalog: { status: "error", models: s.catalog.models, message: error instanceof Error ? error.message : "Could not load the model list." },
      })))
      .finally(() => { this.catalogLoad = null; });
    return this.catalogLoad;
  }

  modelsFor(kind: GenerateKind): GenerateModel[] {
    return modelsOfKind(this.state.get().catalog.models, kind);
  }

  /** The user's choice if it is still listed, else the cheapest listed model. */
  selectedModel(kind: GenerateKind): GenerateModel | undefined {
    const { chosen, catalog } = this.state.get();
    const wanted = chosen[kind];
    return catalog.models.find((m) => m.kind === kind && m.id === wanted) ?? defaultModel(catalog.models, kind);
  }

  /** Looks a model up by id for a kind, or returns the default. Null when an explicit id is unknown to the catalog. */
  resolveModel(kind: GenerateKind, modelId?: string): GenerateModel | null {
    if (modelId === undefined) return this.selectedModel(kind) ?? null;
    return this.state.get().catalog.models.find((m) => m.kind === kind && m.id === modelId) ?? null;
  }

  estimate(request: GenerateRequest): CostEstimate | null {
    return estimateCost({ model: request.model, ...(request.size ? { size: request.size } : {}), characters: request.kind === "speech" ? request.prompt.length : 0 });
  }

  /** Request defaults that hold for every model of a kind: the model's own first listed size, aspect ratio, duration or voice. */
  withDefaults(request: GenerateRequest): GenerateRequest {
    const { model } = request;
    return {
      ...request,
      ...(request.size === undefined && request.kind === "image" && model.sizes[0] ? { size: model.sizes.includes("1024x1024") ? "1024x1024" : model.sizes[0] } : {}),
      ...(request.aspectRatio === undefined && request.kind === "video" && model.aspectRatios.includes("16:9") ? { aspectRatio: "16:9" } : {}),
      ...(request.voice === undefined && request.kind === "speech" && model.voices[0] ? { voice: model.voices[0] } : {}),
    };
  }

  /**
   * Generates one file and imports it into the open project's media library, labelled as generated with its prompt.
   * Only one generation runs at a time. `signal` aborts it in addition to `cancel()`.
   */
  async run(request: GenerateRequest, signal?: AbortSignal): Promise<RunOutcome> {
    if (this.controller) return this.refuse("A generation is already running. Wait for it to finish or cancel it.", "busy");
    if (!this.deps.hasProject()) return this.refuse("Open a project first; generated files are added to its media library.", "no-project");
    const controller = new AbortController();
    const abort = (): void => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) controller.abort();
    this.controller = controller;
    const started = (this.deps.now ?? Date.now)();
    this.state.set({ error: null, result: null, job: { kind: request.kind, prompt: request.prompt, modelName: request.model.name, progress: { phase: "submitting", elapsedMs: 0 } } });
    try {
      const media = await generateMedia({
        apiKey: this.state.get().apiKey, request, signal: controller.signal, ...this.net(),
        ...(this.deps.sleep ? { sleep: this.deps.sleep } : {}),
        onProgress: (progress) => this.state.set((s) => (s.job ? { job: { ...s.job, progress } } : {})),
      });
      const generated: GeneratedProvenance = { prompt: request.prompt, model: request.model.id, provider: PROVIDER_NAME, createdAt: new Date((this.deps.now ?? Date.now)()).toISOString() };
      const file = new File([media.blob], fileName(media), { type: media.mimeType, lastModified: started });
      const outcome = await this.deps.importFile(file, generated);
      const asset = outcome.imported[0];
      if (!asset) {
        const message = outcome.failures[0]?.message ?? "The generated file could not be added to the project.";
        const note = media.chargedUsd !== undefined || media.quotedUsd !== undefined ? " It was generated and billed by Surplus, but not added." : "";
        return this.refuse(`${message}${note}`, "import");
      }
      this.state.set({
        result: { assetId: asset.id, name: asset.name, kind: request.kind, ...(media.quotedUsd !== undefined ? { quotedUsd: media.quotedUsd } : {}), ...(media.chargedUsd !== undefined ? { chargedUsd: media.chargedUsd } : {}) },
      });
      return { ok: true, asset, media };
    } catch (error) {
      if (error instanceof GenerateError) return error.code === "cancelled" ? this.refuse("Cancelled. Nothing was added to your project.", "cancelled") : this.refuse(error.message, error.code);
      return this.refuse(`Generation failed: ${error instanceof Error ? error.message : String(error)}`, "failed");
    } finally {
      signal?.removeEventListener("abort", abort);
      this.controller = null;
      this.state.set({ job: null });
    }
  }

  cancel(): void {
    this.controller?.abort();
  }

  private refuse(error: string, code: Extract<RunOutcome, { ok: false }>["code"]): RunOutcome {
    this.state.set({ error: code === "cancelled" ? null : error });
    return { ok: false, error, code };
  }

  private net(signal?: AbortSignal): { fetch?: typeof fetch; signal?: AbortSignal } {
    return { ...(this.deps.fetch ? { fetch: this.deps.fetch } : {}), ...(signal ? { signal } : {}) };
  }
}

let instance: GenerateService | null = null;

export function getGenerateService(): GenerateService {
  instance ??= new GenerateService({
    prefs: getServices().prefs,
    hasProject: () => getServices().editor.hasProject,
    importFile: (file, generated) => getServices().importFiles([file], undefined, { generated }),
  });
  return instance;
}
