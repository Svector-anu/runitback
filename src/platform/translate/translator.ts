import { findPair, type Translator } from "#/engine/translate";
import type { TranslateBackend } from "./protocol";
import { createWorkerBackend } from "./worker-backend";

const BATCH_SIZE = 8;

export interface OpusTranslatorOptions {
  /** Test seam: replaces the worker-backed model. */
  createBackend?: (model: string) => TranslateBackend;
}

const abortError = (): DOMException => new DOMException("Translation was aborted", "AbortError");

/** On-device Helsinki-NLP opus-mt translation in a worker, a few captions per model call. Nothing is uploaded. */
export function createOpusTranslator(options: OpusTranslatorOptions = {}): Translator {
  const createBackend = options.createBackend ?? createWorkerBackend;
  return {
    async translate({ texts, source, target, signal }): Promise<string[]> {
      const pair = findPair(source, target);
      if (!pair) throw new Error(`Translating ${source} to ${target} is not supported`);
      if (signal?.aborted) throw abortError();
      const backend = createBackend(pair.model);
      const onAbort = (): void => backend.dispose();
      signal?.addEventListener("abort", onAbort, { once: true });
      try {
        const out: string[] = [];
        for (let i = 0; i < texts.length; i += BATCH_SIZE) {
          if (signal?.aborted) throw abortError();
          out.push(...(await backend.translate({ texts: texts.slice(i, i + BATCH_SIZE) })));
        }
        return out;
      } catch (error) {
        if (signal?.aborted) throw abortError();
        throw error;
      } finally {
        signal?.removeEventListener("abort", onAbort);
        backend.dispose();
      }
    },
  };
}
