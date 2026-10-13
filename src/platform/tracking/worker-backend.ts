import type { LumaFrame, MotionSample, Point2, TrackSample } from "#/engine/tracking";
import type { TrackingBackend, TrackWorkerRequest, TrackWorkerResponse } from "./protocol";

interface Pending {
  resolve: (value: TrackWorkerResponse) => void;
  reject: (error: Error) => void;
}

/** Runs the trackers in a dedicated module worker; `dispose` terminates it (cancel). */
export function createTrackingWorkerBackend(): TrackingBackend {
  const worker = new Worker(new URL("./tracker-worker.ts", import.meta.url), { type: "module" });
  const pending = new Map<number, Pending>();
  let nextId = 1;
  const failAll = (error: Error): void => {
    for (const entry of pending.values()) entry.reject(error);
    pending.clear();
  };
  worker.onmessage = (event: MessageEvent<TrackWorkerResponse>) => {
    const entry = pending.get(event.data.id);
    if (!entry) return;
    pending.delete(event.data.id);
    if (event.data.type === "error") entry.reject(new Error(event.data.message));
    else entry.resolve(event.data);
  };
  worker.onerror = (event) => failAll(new Error(event.message || "The motion tracking worker crashed"));

  const send = (request: (id: number) => TrackWorkerRequest, frames: LumaFrame[]): Promise<TrackWorkerResponse> =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      worker.postMessage(request(id), frames.map((f) => f.data.buffer));
    });

  return {
    async track({ frames, times, start }: { frames: LumaFrame[]; times: number[]; start: Point2 }): Promise<TrackSample[]> {
      const response = await send((id) => ({ type: "track", id, frames, times, start }), frames);
      if (response.type !== "track") throw new Error("Unexpected worker reply");
      return response.samples;
    },
    async camera({ frames, times }: { frames: LumaFrame[]; times: number[] }): Promise<MotionSample[]> {
      const response = await send((id) => ({ type: "camera", id, frames, times }), frames);
      if (response.type !== "camera") throw new Error("Unexpected worker reply");
      return response.path;
    },
    dispose() {
      worker.terminate();
      failAll(new DOMException("Motion analysis was aborted", "AbortError"));
    },
  };
}
