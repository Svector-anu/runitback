export interface TranslationPair {
  id: string;
  source: string;
  target: string;
  /** Hugging Face repo with the ONNX export (Xenova's conversion of the Helsinki-NLP model). */
  model: string;
  label: string;
  approxMegabytes: number;
  /** Licence of the upstream Helsinki-NLP model. */
  license: "Apache-2.0" | "CC-BY-4.0";
}

export const LANGUAGE_NAMES: Readonly<Record<string, string>> = { en: "English", es: "Spanish", fr: "French", de: "German" };

/** Only pairs that were run end to end on real model output (docs/AUDIO_VOICE.md). */
export const TRANSLATION_PAIRS: ReadonlyArray<TranslationPair> = [
  { id: "en-es", source: "en", target: "es", model: "Xenova/opus-mt-en-es", label: "English to Spanish", approxMegabytes: 120, license: "Apache-2.0" },
  { id: "en-fr", source: "en", target: "fr", model: "Xenova/opus-mt-en-fr", label: "English to French", approxMegabytes: 120, license: "Apache-2.0" },
  { id: "es-en", source: "es", target: "en", model: "Xenova/opus-mt-es-en", label: "Spanish to English", approxMegabytes: 120, license: "Apache-2.0" },
];

export function findPair(source: string, target: string): TranslationPair | undefined {
  return TRANSLATION_PAIRS.find((p) => p.source === source && p.target === target);
}

export function pairOf(id: string): TranslationPair | undefined {
  return TRANSLATION_PAIRS.find((p) => p.id === id);
}
