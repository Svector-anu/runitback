import { createFaceEngine, toFractionBox, type FrameDetector } from "./face-engine";
import type { FaceWorkerRequest, FaceWorkerResponse } from "./face-protocol";

interface WorkerScope {
  /** MediaPipe's loader calls this when `importScripts` is unavailable, which is always the case in a module worker. */
  import?: (url: string) => Promise<void>;
  onmessage: ((event: MessageEvent<FaceWorkerRequest>) => void) | null;
  postMessage(message: FaceWorkerResponse): void;
}

const scope = self as unknown as WorkerScope;

/** The wasm runtime and the BlazeFace short-range model are served from this origin (public/mediapipe), never a CDN. */
const ASSET_ROOT = `${import.meta.env.BASE_URL}mediapipe`;
const WASM_URL = `${ASSET_ROOT}/wasm`;
const MODEL_URL = `${ASSET_ROOT}/blaze_face_short_range.tflite`;

/**
 * The wasm loader is a classic script that defines a global factory. A module worker cannot `importScripts` it, and
 * `import()` would treat it as a module, so run it as a classic script (own-origin file under public/mediapipe).
 */
async function runClassicScript(url: string): Promise<void> {
  const source = await (await fetch(url)).text();
  (0, eval)(source);
}

/** Loaded lazily so the MediaPipe bundle is fetched only when someone actually indexes faces. */
async function loadDetector(): Promise<FrameDetector> {
  scope.import = runClassicScript;
  const { FaceDetector, FilesetResolver } = await import("@mediapipe/tasks-vision");
  const fileset = await FilesetResolver.forVisionTasks(WASM_URL);
  const detector = await FaceDetector.createFromOptions(fileset, {
    baseOptions: { modelAssetPath: MODEL_URL, delegate: "CPU" },
    runningMode: "VIDEO",
  });
  return async ({ pixels, timestampMs }) => {
    const bitmap = await createImageBitmap(new ImageData(new Uint8ClampedArray(pixels.data), pixels.width, pixels.height));
    try {
      const result = detector.detectForVideo(bitmap, timestampMs);
      return result.detections.flatMap((detection) => {
        const box = detection.boundingBox;
        if (!box) return [];
        return [toFractionBox({ box, score: detection.categories[0]?.score ?? 0, frameWidth: pixels.width, frameHeight: pixels.height })];
      });
    } finally {
      bitmap.close();
    }
  };
}

const engine = createFaceEngine({ loadDetector });

scope.onmessage = (event) => {
  const request = event.data;
  engine.detect({ frames: request.frames })
    .then((frames) => scope.postMessage({ type: "result", id: request.id, frames }))
    .catch((error: unknown) => scope.postMessage({ type: "error", id: request.id, message: error instanceof Error ? error.message : String(error) }));
};
