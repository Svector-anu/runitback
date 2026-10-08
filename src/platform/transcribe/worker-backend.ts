import type { RecogniseInput, RecognisedWord, WhisperBackend, WorkerRequest, WorkerResponse } from "./protocol";

/** Runs recognition in a dedicated module worker; `dispose` terminates it (this is how cancellation frees the model). */
export function createWorkerBackend(model: string): WhisperBackend {
  const worker = new Worker(new URL("./whisper-worker.ts", import.meta.url), { type: "module" });
  const pending = new Map<number, { resolve: (words: RecognisedWord[]) => void; reject: (error: Error) => void }>();
  let nextId = 1;

  const failAll = (error: Error): void => {
    for (const entry of pending.values()) entry.reject(error);
    pending.clear();
  };
  worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
    const message = event.data;
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    if (message.type === "result") entry.resolve(message.words);
    else entry.reject(new Error(message.message));
  };
  worker.onerror = (event) => failAll(new Error(event.message || "The speech worker crashed"));

  return {
    recognise({ samples, language }: RecogniseInput): Promise<RecognisedWord[]> {
      return new Promise((resolve, reject) => {
        const id = nextId++;
        pending.set(id, { resolve, reject });
        const request: WorkerRequest = { type: "recognise", id, model, samples, language };
        worker.postMessage(request, [samples.buffer]);
      });
    },
    dispose() {
      worker.terminate();
      failAll(new DOMException("Transcription was aborted", "AbortError"));
    },
  };
}
