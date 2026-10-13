import { currentScene } from "#/engine/commands";
import { allElements } from "#/engine/timeline";
import { findPair, isCaptionClip, pairOf, translateCaptionClips, type TranslationPair, type Translator } from "#/engine/translate";
import type { TextElement } from "#/engine/model";
import type { PrefsStore } from "#/platform/prefs";
import { createOpusTranslator } from "#/platform/translate";
import { isModelCached } from "#/platform/transcribe";
import { ModelConsent } from "./model-consent";
import { getServices } from "./services";
import { Store } from "./store";

export const TRANSLATE_CONSENT_PREF = "translate-consent-model";

export class TranslateConsentRequiredError extends Error {
  constructor(pair: TranslationPair) {
    super(`The ${pair.label} translation model is not downloaded and the user has not approved the download. Ask the user to press Translate in the Captions panel once for this language, then retry.`);
    this.name = "TranslateConsentRequiredError";
  }
}

export type TranslateOutcome =
  | { status: "needs-consent" }
  | { status: "done"; count: number }
  | { status: "cancelled" }
  | { status: "error"; message: string };

export interface TranslateState {
  running: boolean;
}

const isAbort = (error: unknown): boolean => error instanceof DOMException && error.name === "AbortError";

interface TestHookHost {
  __translator?: Translator;
}

/** A test double may be injected for e2e tests, but only in dev/test builds: Vite strips this branch from production. */
function devTestTranslator(): Translator | undefined {
  if (!import.meta.env.DEV) return undefined;
  return (globalThis as TestHookHost).__translator;
}

/** The consent gate and running job for caption translation. The Captions panel and `translate_captions` both use `gatedTranslator`. */
export class TranslateService {
  readonly state = new Store<TranslateState>({ running: false });
  private controller: AbortController | null = null;

  constructor(private readonly deps: { prefs?: PrefsStore; isModelCached?: (model: string) => Promise<boolean>; translator?: () => Translator } = {}) {}

  private consentFor(pair: TranslationPair): ModelConsent {
    return new ModelConsent({
      prefs: this.deps.prefs ?? getServices().prefs, pref: `${TRANSLATE_CONSENT_PREF}:${pair.id}`, model: pair.model,
      isCached: (model) => (this.deps.isModelCached ?? isModelCached)(model),
    });
  }

  needsConsent(pairId: string): Promise<boolean> {
    const pair = pairOf(pairId);
    return !pair || devTestTranslator() ? Promise.resolve(false) : this.consentFor(pair).needed();
  }

  grantConsent(pairId: string): void {
    const pair = pairOf(pairId);
    if (pair) this.consentFor(pair).grant();
  }

  cancel(): void {
    this.controller?.abort();
  }

  readonly gatedTranslator: Translator = {
    translate: async (input) => {
      const test = devTestTranslator();
      if (test) return test.translate(input);
      const pair = findPair(input.source, input.target);
      if (pair && (await this.needsConsent(pair.id))) throw new TranslateConsentRequiredError(pair);
      return (this.deps.translator?.() ?? createOpusTranslator()).translate(input);
    },
  };

  /** Translates the selected caption clips, or every caption when none is selected, into new caption track(s). */
  async begin(input: { pairId: string }): Promise<TranslateOutcome> {
    const pair = pairOf(input.pairId);
    if (!pair) return { status: "error", message: "That language pair is not supported" };
    if (this.controller) return { status: "error", message: "A translation is already running" };
    if (await this.needsConsent(pair.id)) return { status: "needs-consent" };
    const { editor } = getServices();
    const state = editor.getState();
    const all = allElements(currentScene(state.doc).tracks).map((l) => l.element);
    const selected = new Set(state.selection.elements.map((r) => r.elementId));
    const chosen = all.filter((e): e is TextElement => e.type === "text" && selected.has(e.id));
    const sources = chosen.length > 0 ? chosen : all.filter(isCaptionClip);
    if (sources.length === 0) return { status: "error", message: "There are no captions to translate. Import an .srt or add captions from a transcript first." };
    const controller = new AbortController();
    this.controller = controller;
    this.state.set({ running: true });
    try {
      const result = await translateCaptionClips({ editor, sources, source: pair.source, target: pair.target, translator: this.gatedTranslator, signal: controller.signal });
      return { status: "done", count: result.elementIds.length };
    } catch (error) {
      if (isAbort(error)) return { status: "cancelled" };
      return { status: "error", message: error instanceof Error ? error.message : String(error) };
    } finally {
      this.controller = null;
      this.state.set({ running: false });
    }
  }
}

let shared: TranslateService | null = null;

export function getTranslateService(): TranslateService {
  shared ??= new TranslateService();
  return shared;
}
