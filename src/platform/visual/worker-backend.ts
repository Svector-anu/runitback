import type { ClipBackend, ImagePixels, WorkerRequest, WorkerResponse } from "./protocol";

interface Pending {
  resolve: (rows: Float32Array[]) => void;
  reject: (error: Error) => void;
  onLoad?: (fraction: number) => void;
}

function rowsOf(data: Float32Array, dimensions: number): Float32Array[] {
  const count = dimensions > 0 ? Math.floor(data.length / dimensions) : 0;
  return Array.from({ length: count }, (_, i) => data.slice(i * dimensions, (i + 1) * dimensions));
}

/** Runs embedding in a dedicated module worker; `dispose` terminates it (this is how cancellation and idling free the model). */
export function createWorkerBackend(model: string): ClipBackend {
  const worker = new Worker(new URL("./clip-worker.ts", import.meta.url), { type: "module" });
  const pending = new Map<number, Pending>();
  let nextId = 1;

  const failAll = (error: Error): void => {
    for (const entry of pending.values()) entry.reject(error);
    pending.clear();
  };
  worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
    const message = event.data;
    const entry = pending.get(message.id);
    if (!entry) return;
    if (message.type === "loading") {
      entry.onLoad?.(message.fraction);
      return;
    }
    pending.delete(message.id);
    if (message.type === "result") entry.resolve(rowsOf(message.data, message.dimensions));
    else entry.reject(new Error(message.message));
  };
  worker.onerror = (event) => failAll(new Error(event.message || "The visual search worker crashed"));

  function send(build: (id: number) => { request: WorkerRequest; transfer: Transferable[] }, onLoad?: (fraction: number) => void): Promise<Float32Array[]> {
    return new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject, ...(onLoad ? { onLoad } : {}) });
      const { request, transfer } = build(id);
      worker.postMessage(request, transfer);
    });
  }

  return {
    embedImages({ images, onLoad }: { images: ImagePixels[]; onLoad?: (fraction: number) => void }) {
      return send((id) => ({ request: { type: "embed-images", id, model, images }, transfer: images.map((image) => image.data.buffer) }), onLoad);
    },
    embedTexts({ texts, onLoad }: { texts: string[]; onLoad?: (fraction: number) => void }) {
      return send((id) => ({ request: { type: "embed-texts", id, model, texts }, transfer: [] }), onLoad);
    },
    dispose() {
      worker.terminate();
      failAll(new DOMException("Visual indexing was aborted", "AbortError"));
    },
  };
}
