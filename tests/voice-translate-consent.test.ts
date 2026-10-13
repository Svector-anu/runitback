import { describe, expect, it } from "vitest";
import { PrefsStore } from "#/platform/prefs";
import type { SpeechEngine } from "#/engine/voiceover";
import type { Translator } from "#/engine/translate";
import { TTS_CONSENT_PREF, TtsConsentRequiredError, VoiceService } from "#/app/voice-service";
import { TRANSLATE_CONSENT_PREF, TranslateConsentRequiredError, TranslateService } from "#/app/translate-service";
import { findPair } from "#/engine/translate";

const memoryPrefs = (): PrefsStore => {
  const data = new Map<string, string>();
  return new PrefsStore({ getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) });
};
const isString = (v: unknown): v is string => typeof v === "string";

describe("VoiceService consent gate", () => {
  function setup(cached = false) {
    const calls: string[] = [];
    const engine: SpeechEngine = { synthesize: async ({ text }) => { calls.push(text); return { samples: new Float32Array(160), sampleRate: 16_000 }; } };
    const prefs = memoryPrefs();
    const service = new VoiceService({ prefs, model: "m/speech", isModelCached: async () => cached, engine: () => engine });
    return { service, prefs, calls };
  }

  it("never reaches the model until the user consents, and tells the agent what to ask the user", async () => {
    const { service, calls } = setup();
    expect(await service.needsConsent()).toBe(true);
    await expect(service.gatedEngine.synthesize({ text: "hi", voiceId: "slt" })).rejects.toBeInstanceOf(TtsConsentRequiredError);
    await expect(service.gatedEngine.synthesize({ text: "hi", voiceId: "slt" })).rejects.toThrow(/Text to speech panel/);
    expect(await service.begin({ text: "hi" })).toEqual({ status: "needs-consent" });
    expect(calls).toEqual([]);
  });

  it("runs after consent (remembered per model in prefs) or when the model is already cached", async () => {
    const granted = setup();
    granted.service.grantConsent();
    expect(granted.prefs.read(TTS_CONSENT_PREF, "", isString)).toBe("m/speech");
    await granted.service.gatedEngine.synthesize({ text: "hi", voiceId: "slt" });
    expect(granted.calls).toEqual(["hi"]);
    const cached = setup(true);
    expect(await cached.service.needsConsent()).toBe(false);
  });
});

describe("TranslateService consent gate", () => {
  function setup() {
    const calls: string[][] = [];
    const translator: Translator = { translate: async ({ texts }) => { calls.push([...texts]); return texts.map((t) => `es:${t}`); } };
    const prefs = memoryPrefs();
    const service = new TranslateService({ prefs, isModelCached: async () => false, translator: () => translator });
    return { service, prefs, calls };
  }

  it("asks per language pair and stays out of the model until then", async () => {
    const { service, prefs, calls } = setup();
    expect(await service.needsConsent("en-es")).toBe(true);
    await expect(service.gatedTranslator.translate({ texts: ["hi"], source: "en", target: "es" })).rejects.toBeInstanceOf(TranslateConsentRequiredError);
    expect(calls).toEqual([]);
    service.grantConsent("en-es");
    expect(prefs.read(`${TRANSLATE_CONSENT_PREF}:en-es`, "", isString)).toBe(findPair("en", "es")?.model);
    expect(await service.gatedTranslator.translate({ texts: ["hi"], source: "en", target: "es" })).toEqual(["es:hi"]);
    expect(await service.needsConsent("en-fr")).toBe(true);
  });
});
