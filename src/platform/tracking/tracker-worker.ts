import { cameraPath, trackPoint } from "#/engine/tracking";
import type { TrackWorkerRequest, TrackWorkerResponse } from "./protocol";

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<TrackWorkerRequest>) => void) | null;
  postMessage(message: TrackWorkerResponse): void;
};

scope.onmessage = (event) => {
  const request = event.data;
  try {
    if (request.type === "track") scope.postMessage({ type: "track", id: request.id, samples: trackPoint({ frames: request.frames, times: request.times, start: request.start }) });
    else scope.postMessage({ type: "camera", id: request.id, path: cameraPath({ frames: request.frames, times: request.times }) });
  } catch (error) {
    scope.postMessage({ type: "error", id: request.id, message: error instanceof Error ? error.message : String(error) });
  }
};
