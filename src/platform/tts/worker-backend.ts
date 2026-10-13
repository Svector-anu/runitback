import type { TtsBackend, TtsRequest, TtsResponse } from "./protocol";

/** Runs synthesis in a dedicated module worker; `dispose` terminates it, which frees the model. */
export function createWorkerBackend(input: { model: string; onProgress?: (fraction: number) => void }): TtsBackend {
  const worker = new Worker(new URL("./tts-worker.ts", import.meta.url), { type: "module" });
  const pending = new Map<number, { resolve: (value: { samples: Float32Array; sampleRate: number }) => void; reject: (error: Error) => void }>();
  let nextId = 1;
  const failAll = (error: Error): void => {
    for (const entry of pending.values()) entry.reject(error);
    pending.clear();
  };
  worker.onmessage = (event: MessageEvent<TtsResponse>) => {
    const message = event.data;
    if (message.type === "progress") {
      input.onProgress?.(message.fraction);
      return;
    }
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    if (message.type === "result") entry.resolve({ samples: message.samples, sampleRate: message.sampleRate });
    else entry.reject(new Error(message.message));
  };
  worker.onerror = (event) => failAll(new Error(event.message || "The speech worker crashed"));
  return {
    synthesize({ text, speaker }) {
      return new Promise((resolve, reject) => {
        const id = nextId++;
        pending.set(id, { resolve, reject });
        const request: TtsRequest = { type: "synthesize", id, model: input.model, text, speaker };
        worker.postMessage(request);
      });
    },
    dispose() {
      worker.terminate();
      failAll(new DOMException("Speech generation was aborted", "AbortError"));
    },
  };
}
