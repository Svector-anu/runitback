import { encodeWav } from "#/engine/audio";
import { DEFAULT_VOICE_ID, synthesizeVoiceover, type SpeechEngine } from "#/engine/voiceover";
import { createSpeechT5Engine, SPEECHT5_APPROX_MEGABYTES, SPEECHT5_MODEL, type DisposableSpeechEngine } from "#/platform/tts";
import type { PrefsStore } from "#/platform/prefs";
import { isModelCached } from "#/platform/transcribe";
import { insertPayload } from "./insert";
import { ModelConsent } from "./model-consent";
import { getServices } from "./services";
import { Store } from "./store";

export const TTS_CONSENT_PREF = "tts-consent-model";

export const TTS_DOWNLOAD_NOTE = { model: "SpeechT5 voice model", approxMegabytes: SPEECHT5_APPROX_MEGABYTES } as const;

export class TtsConsentRequiredError extends Error {
  constructor() {
    super("The voice model is not downloaded and the user has not approved the download. Ask the user to press Generate in the Text to speech panel (Assets > Text) once, then retry.");
    this.name = "TtsConsentRequiredError";
  }
}

export type VoiceoverOutcome =
  | { status: "needs-consent" }
  | { status: "done"; assetId: string; seconds: number }
  | { status: "cancelled" }
  | { status: "error"; message: string };

export interface VoiceState {
  running: boolean;
  /** "downloading" while the model files arrive, "speaking" while text is being turned into audio. */
  phase: "idle" | "downloading" | "speaking";
  /** 0..1 within the phase. */
  progress: number;
}

const isAbort = (error: unknown): boolean => error instanceof DOMException && error.name === "AbortError";

interface TestHookHost {
  __speechEngine?: SpeechEngine;
}

/** A test double may be injected for e2e tests, but only in dev/test builds: Vite strips this branch from production. */
function devTestEngine(): SpeechEngine | undefined {
  if (!import.meta.env.DEV) return undefined;
  return (globalThis as TestHookHost).__speechEngine;
}

/**
 * Owns the consent gate and the running job for text to speech. The panel and the agent's `generate_voiceover` tool
 * both go through `gatedEngine`, so neither can start a model download the user has not approved.
 */
export class VoiceService {
  readonly state = new Store<VoiceState>({ running: false, phase: "idle", progress: 0 });
  private readonly consent: ModelConsent;
  private controller: AbortController | null = null;
  private engine: DisposableSpeechEngine | null = null;

  constructor(private readonly deps: { prefs: PrefsStore; model?: string; isModelCached?: (model: string) => Promise<boolean>; engine?: () => SpeechEngine }) {
    this.consent = new ModelConsent({
      prefs: deps.prefs, pref: TTS_CONSENT_PREF, model: deps.model ?? SPEECHT5_MODEL,
      isCached: (model) => (deps.isModelCached ?? isModelCached)(model),
    });
  }

  hasConsent(): boolean {
    return this.consent.has();
  }

  grantConsent(): void {
    this.consent.grant();
  }

  needsConsent(): Promise<boolean> {
    return devTestEngine() ? Promise.resolve(false) : this.consent.needed();
  }

  cancel(): void {
    this.controller?.abort();
  }

  private realEngine(): DisposableSpeechEngine {
    this.engine ??= createSpeechT5Engine({
      onDownloadProgress: (fraction) => this.state.set({ phase: "downloading", progress: fraction }),
    });
    return this.engine;
  }

  /** A `SpeechEngine` that refuses (TtsConsentRequiredError) when a download would need approval. */
  readonly gatedEngine: SpeechEngine = {
    synthesize: async (input) => {
      const test = devTestEngine();
      if (test) return test.synthesize(input);
      if (await this.needsConsent()) throw new TtsConsentRequiredError();
      return (this.deps.engine?.() ?? this.realEngine()).synthesize(input);
    },
  };

  /** Stores WAV bytes as a project asset (probed, persisted, registered) and returns it. */
  async importWav(input: { name: string; wav: Uint8Array }) {
    const file = new File([input.wav as BlobPart], input.name, { type: "audio/wav" });
    const outcome = await getServices().importFiles([file]);
    const asset = outcome.imported[0];
    if (!asset) throw new Error(outcome.failures[0]?.message ?? "The generated audio could not be stored");
    return asset;
  }

  /** The UI path: reports `needs-consent` instead of throwing so the caller can show the confirmation dialog. */
  async begin(input: { text: string; voiceId?: string; speed?: number }): Promise<VoiceoverOutcome> {
    if (this.controller) return { status: "error", message: "A voice-over is already being generated" };
    if (await this.needsConsent()) return { status: "needs-consent" };
    const controller = new AbortController();
    this.controller = controller;
    this.state.set({ running: true, phase: "downloading", progress: 0 });
    try {
      const speech = await synthesizeVoiceover({
        engine: this.gatedEngine, text: input.text, voiceId: input.voiceId ?? DEFAULT_VOICE_ID, speed: input.speed ?? 1, signal: controller.signal,
        onProgress: (fraction) => this.state.set({ phase: "speaking", progress: fraction }),
      });
      const label = input.text.replace(/\s+/g, " ").trim();
      const asset = await this.importWav({
        name: `Voice-over: ${label.length > 32 ? `${label.slice(0, 32)}...` : label}.wav`,
        wav: encodeWav({ channels: [speech.samples], sampleRate: speech.sampleRate }),
      });
      const { editor } = getServices();
      const inserted = insertPayload({ editor, payload: { kind: "media", assetId: asset.id, mediaType: "audio" }, startTime: editor.playback.getState().currentTime });
      if (!inserted.ok) return { status: "error", message: inserted.message };
      return { status: "done", assetId: asset.id, seconds: speech.samples.length / speech.sampleRate };
    } catch (error) {
      if (isAbort(error)) return { status: "cancelled" };
      return { status: "error", message: error instanceof Error ? error.message : String(error) };
    } finally {
      this.controller = null;
      this.state.set({ running: false, phase: "idle", progress: 0 });
    }
  }
}

let shared: VoiceService | null = null;

export function getVoiceService(): VoiceService {
  shared ??= new VoiceService({ prefs: getServices().prefs });
  return shared;
}
