import { TICKS_PER_SECOND } from "#/engine/time";
import type { VisualEmbeddings, VisualIndexer, VisualSearcher, VisualStore } from "#/engine/visual";
import { DEFAULT_CLIP_MODEL, IdbVisualStore, createClipIndexer, createClipSearcher, isClipModelCached, type ClipSearcher, type Footage } from "#/platform/visual";
import type { PrefsStore } from "#/platform/prefs";
import { sharedAnalysisStore } from "./agent/platform-tools";
import { createAnalysisProvider } from "./agent/reference-wiring";
import { ModelConsent } from "./model-consent";
import { getServices } from "./services";
import { Store } from "./store";

/** Remembers which image model the user agreed to download in this browser. */
export const VISUAL_CONSENT_PREF = "visual-consent-model";

export const VISUAL_MODEL_NOTE = { model: "clip-vit-base-patch32", approxMegabytes: 156 } as const;

/** Carries the same `name` as the speech service's error, which is what the agent tools look for. */
export class VisualConsentRequiredError extends Error {
  constructor() {
    super("The visual search model is not downloaded and the user has not approved the download. Ask the user to press Index visuals on a video in the Assets panel, then retry.");
    this.name = "ConsentRequiredError";
  }
}

export type VisualIndexOutcome =
  | { status: "needs-consent" }
  | { status: "done"; embeddings: VisualEmbeddings }
  | { status: "cancelled" }
  | { status: "error"; message: string };

export interface VisualServiceDeps {
  store: VisualStore;
  /** Resolved per run so a dev/test double installed after startup is honoured. */
  indexer: () => VisualIndexer;
  searcher: () => VisualSearcher;
  prefs: PrefsStore;
  model?: string;
  isModelCached?: (model: string) => Promise<boolean>;
}

export interface VisualState {
  /** Progress 0..1 of each running indexing job, by asset id. */
  jobs: Readonly<Record<string, number>>;
}

const isAbort = (error: unknown): boolean => error instanceof DOMException && error.name === "AbortError";

/**
 * Owns the consent gate and the running jobs for visual search. The Index visuals button and the agent's
 * `index_visuals` / `find_visual_moments` tools all go through the gated indexer and searcher, so none of them can
 * start a model download the user has not approved.
 */
export class VisualService {
  readonly state = new Store<VisualState>({ jobs: {} });
  private readonly controllers = new Map<string, AbortController>();
  private readonly consent: ModelConsent;
  /** A searcher that refuses (ConsentRequiredError) when embedding the query would download the model unapproved. */
  readonly gatedSearcher: VisualSearcher;

  constructor(private readonly deps: VisualServiceDeps) {
    this.consent = new ModelConsent({
      prefs: deps.prefs, pref: VISUAL_CONSENT_PREF, model: deps.model ?? DEFAULT_CLIP_MODEL,
      isCached: (model) => (deps.isModelCached ?? isClipModelCached)(model),
    });
    this.gatedSearcher = {
      get model(): string {
        return deps.searcher().model;
      },
      embedText: async (query) => {
        if (await this.needsConsent()) throw new VisualConsentRequiredError();
        return deps.searcher().embedText(query);
      },
    };
  }

  get store(): VisualStore {
    return this.deps.store;
  }

  hasConsent(): boolean {
    return this.consent.has();
  }

  grantConsent(): void {
    this.consent.grant();
  }

  needsConsent(): Promise<boolean> {
    return this.consent.needed();
  }

  private setProgress(assetId: string, fraction: number | null): void {
    this.state.set((s) => {
      const jobs = { ...s.jobs };
      if (fraction === null) delete jobs[assetId];
      else jobs[assetId] = fraction;
      return { jobs };
    });
  }

  cancel(assetId: string): void {
    this.controllers.get(assetId)?.abort();
  }

  /** An indexer that refuses (ConsentRequiredError) when a download would need approval, and records progress. Callers save the result. */
  readonly gatedIndexer: VisualIndexer = {
    index: async (input) => {
      if (await this.needsConsent()) throw new VisualConsentRequiredError();
      if (this.controllers.has(input.assetId)) throw new Error("This asset is already being indexed");
      const controller = new AbortController();
      this.controllers.set(input.assetId, controller);
      input.signal?.addEventListener("abort", () => controller.abort(), { once: true });
      this.setProgress(input.assetId, 0);
      try {
        return await this.deps.indexer().index({
          ...input,
          signal: controller.signal,
          onProgress: (fraction) => {
            this.setProgress(input.assetId, fraction);
            input.onProgress?.(fraction);
          },
        });
      } finally {
        this.controllers.delete(input.assetId);
        this.setProgress(input.assetId, null);
      }
    },
  };

  /** The UI path: reports `needs-consent` instead of throwing so the caller can show the confirmation dialog. */
  async begin(assetId: string): Promise<VisualIndexOutcome> {
    if (await this.needsConsent()) return { status: "needs-consent" };
    try {
      const embeddings = await this.gatedIndexer.index({ assetId });
      await this.deps.store.save(embeddings);
      return { status: "done", embeddings };
    } catch (error) {
      if (isAbort(error)) return { status: "cancelled" };
      return { status: "error", message: error instanceof Error ? error.message : String(error) };
    }
  }
}

interface TestHookHost {
  __visual?: { indexer?: VisualIndexer; searcher?: VisualSearcher };
}

/** Test doubles may be injected for e2e tests, but only in dev/test builds: Vite strips this branch from production. */
export function devTestVisual(): TestHookHost["__visual"] {
  if (!import.meta.env.DEV) return undefined;
  return (globalThis as TestHookHost).__visual;
}

let sharedStore: VisualStore | null = null;

export function getVisualStore(): VisualStore {
  sharedStore ??= new IdbVisualStore();
  return sharedStore;
}

/** Scene cuts come from the cached analysis (computed on demand); without it only the regular grid is sampled. */
async function footageOf(assetId: string): Promise<Footage> {
  const { editor } = getServices();
  const provider = createAnalysisProvider({ editor, runtime: () => getServices().runtime, analysisStore: sharedAnalysisStore });
  let analysis;
  try {
    analysis = await provider.get(assetId);
  } catch {
    analysis = undefined;
  }
  const info = editor.getAsset(assetId);
  const durationSeconds = analysis?.durationSeconds ?? (info?.duration !== undefined ? info.duration / TICKS_PER_SECOND : 0);
  return { durationSeconds, cutTimes: analysis?.sceneCuts.map((c) => c.time) ?? [] };
}

let realSearcher: ClipSearcher | null = null;

let sharedService: VisualService | null = null;

export function getVisualService(): VisualService {
  sharedService ??= new VisualService({
    store: getVisualStore(),
    prefs: getServices().prefs,
    indexer: () => devTestVisual()?.indexer ?? createClipIndexer({ getVideo: (assetId) => getServices().runtime.getBlob(assetId), getFootage: footageOf }),
    searcher: () => devTestVisual()?.searcher ?? (realSearcher ??= createClipSearcher()),
  });
  return sharedService;
}
