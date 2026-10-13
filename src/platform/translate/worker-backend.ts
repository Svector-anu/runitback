import type { TranslateBackend, TranslateRequest, TranslateResponse } from "./protocol";

/** Runs translation in a dedicated module worker; `dispose` terminates it, which is how cancellation frees the model. */
export function createWorkerBackend(model: string): TranslateBackend {
  const worker = new Worker(new URL("./translate-worker.ts", import.meta.url), { type: "module" });
  const pending = new Map<number, { resolve: (texts: string[]) => void; reject: (error: Error) => void }>();
  let nextId = 1;
  const failAll = (error: Error): void => {
    for (const entry of pending.values()) entry.reject(error);
    pending.clear();
  };
  worker.onmessage = (event: MessageEvent<TranslateResponse>) => {
    const message = event.data;
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    if (message.type === "result") entry.resolve(message.texts);
    else entry.reject(new Error(message.message));
  };
  worker.onerror = (event) => failAll(new Error(event.message || "The translation worker crashed"));
  return {
    translate({ texts }): Promise<string[]> {
      return new Promise((resolve, reject) => {
        const id = nextId++;
        pending.set(id, { resolve, reject });
        const request: TranslateRequest = { type: "translate", id, model, texts };
        worker.postMessage(request);
      });
    },
    dispose() {
      worker.terminate();
      failAll(new DOMException("Translation was aborted", "AbortError"));
    },
  };
}
