import type { RecogniseInput, RecognisedWord } from "./protocol";

/** The slice of a transformers.js automatic-speech-recognition pipeline this module uses. */
export interface AsrPipeline {
  (audio: Float32Array, options: Record<string, unknown>): Promise<unknown>;
}

export interface WhisperEngineDeps {
  loadPipeline(model: string): Promise<AsrPipeline>;
}

interface RawWord {
  text?: unknown;
  timestamp?: unknown;
}

const ENGLISH_ONLY = /\.en(_|$)/;
const NON_SPEECH = /^[[(*♪].*[\])*♪]$/;

/** Maps word-level pipeline output to words; open-ended last words are closed at the window end. */
export function wordsFromPipelineOutput(output: unknown, windowSeconds: number): RecognisedWord[] {
  const chunks = (output as { chunks?: RawWord[] } | null)?.chunks;
  if (!Array.isArray(chunks)) return [];
  const words: RecognisedWord[] = [];
  for (const chunk of chunks) {
    const text = typeof chunk.text === "string" ? chunk.text.trim() : "";
    const range = chunk.timestamp;
    if (!text || NON_SPEECH.test(text) || !Array.isArray(range)) continue;
    const start = Number(range[0]);
    if (!Number.isFinite(start)) continue;
    const rawEnd = Number(range[1]);
    const end = Number.isFinite(rawEnd) && rawEnd >= start ? rawEnd : Math.min(windowSeconds, start + 0.3);
    words.push({ text, startSeconds: start, endSeconds: end });
  }
  return words;
}

/** Model-agnostic recogniser core, shared by the worker and by tests (which inject a fake pipeline). */
export function createWhisperEngine(deps: WhisperEngineDeps): {
  recognise(input: RecogniseInput & { model: string; sampleRate: number }): Promise<RecognisedWord[]>;
} {
  const loaded = new Map<string, Promise<AsrPipeline>>();
  return {
    async recognise({ model, samples, language, sampleRate }) {
      let pipe = loaded.get(model);
      if (!pipe) {
        pipe = deps.loadPipeline(model);
        loaded.set(model, pipe);
        pipe.catch(() => loaded.delete(model));
      }
      const asr = await pipe;
      const options: Record<string, unknown> = { return_timestamps: "word" };
      if (language && !ENGLISH_ONLY.test(model)) options.language = language;
      return wordsFromPipelineOutput(await asr(samples, options), samples.length / sampleRate);
    },
  };
}
