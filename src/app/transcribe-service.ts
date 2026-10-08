import type { Transcriber, Transcript, TranscriptStore } from "#/engine/transcript/types";
import { DEFAULT_WHISPER_MODEL, IdbTranscriptStore, createWhisperTranscriber, isModelCached } from "#/platform/transcribe";
import type { PrefsStore } from "#/platform/prefs";
import { ModelConsent } from "./model-consent";
import { getServices } from "./services";
import { Store } from "./store";

/** Remembers which speech model the user agreed to download in this browser. */
export const TRANSCRIBE_CONSENT_PREF = "transcribe-consent-model";

export const MODEL_DOWNLOAD_NOTE = { model: "whisper-tiny.en", approxMegabytes: 50, approxMegabytesGpu: 70 } as const;

export class ConsentRequiredError extends Error {
  constructor() {
    super("The speech model is not downloaded and the user has not approved the download. Ask the user to press Transcribe on this asset in the Assets panel, then retry.");
    this.name = "ConsentRequiredError";
  }
}

export type TranscribeOutcome =
  | { status: "needs-consent" }
  | { status: "done"; transcript: Transcript }
  | { status: "cancelled" }
  | { status: "error"; message: string };

export interface TranscribeServiceDeps {
  store: TranscriptStore;
  /** Resolved per run so a dev/test double installed after startup is honoured. */
  transcriber: () => Transcriber;
  prefs: PrefsStore;
  model?: string;
  isModelCached?: (model: string) => Promise<boolean>;
}

export interface TranscribeState {
  /** Progress 0..1 of each running transcription, by asset id. */
  jobs: Readonly<Record<string, number>>;
}

const isAbort = (error: unknown): boolean => error instanceof DOMException && error.name === "AbortError";

/**
 * Owns the consent gate and the running jobs for speech-to-text. The Transcribe button and the agent's
 * `transcribe_asset` tool both go through `gatedTranscriber`, so neither can start a model download the user has not approved.
 */
export class TranscribeService {
  readonly state = new Store<TranscribeState>({ jobs: {} });
  private readonly controllers = new Map<string, AbortController>();
  private readonly consent: ModelConsent;

  constructor(private readonly deps: TranscribeServiceDeps) {
    this.consent = new ModelConsent({
      prefs: deps.prefs, pref: TRANSCRIBE_CONSENT_PREF, model: deps.model ?? DEFAULT_WHISPER_MODEL,
      isCached: (model) => (deps.isModelCached ?? isModelCached)(model),
    });
  }

  get store(): TranscriptStore {
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

  /** A `Transcriber` that refuses (ConsentRequiredError) when a download would need approval, and records progress. */
  readonly gatedTranscriber: Transcriber = {
    transcribe: async (input) => {
      if (await this.needsConsent()) throw new ConsentRequiredError();
      if (this.controllers.has(input.assetId)) throw new Error("This asset is already being transcribed");
      const controller = new AbortController();
      this.controllers.set(input.assetId, controller);
      input.signal?.addEventListener("abort", () => controller.abort(), { once: true });
      this.setProgress(input.assetId, 0);
      try {
        const transcript = await this.deps.transcriber().transcribe({
          ...input,
          signal: controller.signal,
          onProgress: (fraction) => {
            this.setProgress(input.assetId, fraction);
            input.onProgress?.(fraction);
          },
        });
        await this.deps.store.save(transcript);
        return transcript;
      } finally {
        this.controllers.delete(input.assetId);
        this.setProgress(input.assetId, null);
      }
    },
  };

  /** The UI path: reports `needs-consent` instead of throwing so the caller can show the confirmation dialog. */
  async begin(assetId: string): Promise<TranscribeOutcome> {
    if (await this.needsConsent()) return { status: "needs-consent" };
    try {
      return { status: "done", transcript: await this.gatedTranscriber.transcribe({ assetId }) };
    } catch (error) {
      if (isAbort(error)) return { status: "cancelled" };
      return { status: "error", message: error instanceof Error ? error.message : String(error) };
    }
  }
}

interface TestHookHost {
  __transcriber?: Transcriber;
}

/** A test double may be injected for e2e tests, but only in dev/test builds: Vite strips this branch from production. */
export function devTestTranscriber(): Transcriber | undefined {
  if (!import.meta.env.DEV) return undefined;
  return (globalThis as TestHookHost).__transcriber;
}

let sharedStore: TranscriptStore | null = null;

export function getTranscriptStore(): TranscriptStore {
  sharedStore ??= new IdbTranscriptStore();
  return sharedStore;
}

let sharedService: TranscribeService | null = null;

export function getTranscribeService(): TranscribeService {
  sharedService ??= new TranscribeService({
    store: getTranscriptStore(),
    prefs: getServices().prefs,
    transcriber: () => devTestTranscriber() ?? createWhisperTranscriber({ getAudio: (assetId) => getServices().runtime.getBlob(assetId) }),
  });
  return sharedService;
}
