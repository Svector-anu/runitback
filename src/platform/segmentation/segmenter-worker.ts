import type { SegmentWorkerRequest, SegmentWorkerResponse, SegmenterModelId, SegmentedFrame } from "./protocol";

interface WorkerScope {
  import?: (url: string) => Promise<void>;
  onmessage: ((event: MessageEvent<SegmentWorkerRequest>) => void) | null;
  postMessage(message: SegmentWorkerResponse, transfer?: Transferable[]): void;
}

const scope = self as unknown as WorkerScope;

/** Same self-hosted runtime as face detection (public/mediapipe); the two selfie models sit next to it. Nothing is fetched from a CDN. */
const ASSET_ROOT = `${import.meta.env.BASE_URL}mediapipe`;
const WASM_URL = `${ASSET_ROOT}/wasm`;
const modelUrl = (model: SegmenterModelId): string => `${ASSET_ROOT}/${model}.tflite`;

async function runClassicScript(url: string): Promise<void> {
  const source = await (await fetch(url)).text();
  (0, eval)(source);
}

type Segmenter = import("@mediapipe/tasks-vision").ImageSegmenter;
const segmenters = new Map<SegmenterModelId, Promise<Segmenter>>();

function segmenterFor(model: SegmenterModelId): Promise<Segmenter> {
  let entry = segmenters.get(model);
  if (!entry) {
    entry = (async () => {
      scope.import = runClassicScript;
      const { ImageSegmenter, FilesetResolver } = await import("@mediapipe/tasks-vision");
      const fileset = await FilesetResolver.forVisionTasks(WASM_URL);
      return ImageSegmenter.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: modelUrl(model), delegate: "CPU" },
        runningMode: "IMAGE",
        outputConfidenceMasks: true,
        outputCategoryMask: false,
      });
    })();
    segmenters.set(model, entry);
  }
  return entry;
}

/** The confidence mask of the "person" class: the last one when the model reports background first, the only one otherwise. */
async function segmentFrames(request: SegmentWorkerRequest): Promise<SegmentedFrame[]> {
  const segmenter = await segmenterFor(request.model);
  const out: SegmentedFrame[] = [];
  for (const frame of request.frames) {
    const bitmap = await createImageBitmap(new ImageData(new Uint8ClampedArray(frame.pixels.data), frame.pixels.width, frame.pixels.height));
    try {
      const result = segmenter.segment(bitmap);
      const masks = result.confidenceMasks ?? [];
      const person = masks[masks.length - 1];
      if (!person) throw new Error("The segmentation model returned no mask");
      const confidence = person.getAsFloat32Array();
      const data = new Uint8Array(confidence.length);
      for (let i = 0; i < confidence.length; i++) data[i] = Math.round(Math.min(1, Math.max(0, confidence[i] as number)) * 255);
      out.push({ time: frame.time, width: person.width, height: person.height, data });
      result.close();
    } finally {
      bitmap.close();
    }
  }
  return out;
}

scope.onmessage = (event) => {
  const request = event.data;
  segmentFrames(request)
    .then((frames) => scope.postMessage({ type: "result", id: request.id, frames }, frames.map((f) => f.data.buffer)))
    .catch((error: unknown) => scope.postMessage({ type: "error", id: request.id, message: error instanceof Error ? error.message : String(error) }));
};
