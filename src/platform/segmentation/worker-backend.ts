import type { SegmentBackend, SegmentFrameInput, SegmentedFrame, SegmenterModelId, SegmentWorkerRequest, SegmentWorkerResponse } from "./protocol";

interface Pending {
  resolve: (frames: SegmentedFrame[]) => void;
  reject: (error: Error) => void;
}

/** Runs the segmenter in a dedicated module worker; `dispose` terminates it (this is how cancelling frees the model). */
export function createSegmentWorkerBackend(): SegmentBackend {
  const worker = new Worker(new URL("./segmenter-worker.ts", import.meta.url), { type: "module" });
  const pending = new Map<number, Pending>();
  let nextId = 1;

  const failAll = (error: Error): void => {
    for (const entry of pending.values()) entry.reject(error);
    pending.clear();
  };
  worker.onmessage = (event: MessageEvent<SegmentWorkerResponse>) => {
    const message = event.data;
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    if (message.type === "result") entry.resolve(message.frames);
    else entry.reject(new Error(message.message));
  };
  worker.onerror = (event) => failAll(new Error(event.message || "The background removal worker crashed"));

  return {
    segment({ model, frames }: { model: SegmenterModelId; frames: SegmentFrameInput[] }) {
      return new Promise((resolve, reject) => {
        const id = nextId++;
        pending.set(id, { resolve, reject });
        const request: SegmentWorkerRequest = { type: "segment", id, model, frames };
        worker.postMessage(request, frames.map((frame) => frame.pixels.data.buffer));
      });
    },
    dispose() {
      worker.terminate();
      failAll(new DOMException("Background analysis was aborted", "AbortError"));
    },
  };
}
