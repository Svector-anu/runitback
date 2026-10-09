import type { FaceFrame } from "#/engine/face";
import type { FaceBackend, FaceWorkerRequest, FaceWorkerResponse, FrameInput } from "./face-protocol";

interface Pending {
  resolve: (frames: FaceFrame[]) => void;
  reject: (error: Error) => void;
}

/** Runs detection in a dedicated module worker; `dispose` terminates it (this is how cancellation frees the model). */
export function createFaceWorkerBackend(): FaceBackend {
  const worker = new Worker(new URL("./face-worker.ts", import.meta.url), { type: "module" });
  const pending = new Map<number, Pending>();
  let nextId = 1;

  const failAll = (error: Error): void => {
    for (const entry of pending.values()) entry.reject(error);
    pending.clear();
  };
  worker.onmessage = (event: MessageEvent<FaceWorkerResponse>) => {
    const message = event.data;
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    if (message.type === "result") entry.resolve(message.frames);
    else entry.reject(new Error(message.message));
  };
  worker.onerror = (event) => failAll(new Error(event.message || "The face detection worker crashed"));

  return {
    detect({ frames }: { frames: FrameInput[] }) {
      return new Promise((resolve, reject) => {
        const id = nextId++;
        pending.set(id, { resolve, reject });
        const request: FaceWorkerRequest = { type: "detect-faces", id, frames };
        worker.postMessage(request, frames.map((frame) => frame.pixels.data.buffer));
      });
    },
    dispose() {
      worker.terminate();
      failAll(new DOMException("Face indexing was aborted", "AbortError"));
    },
  };
}
