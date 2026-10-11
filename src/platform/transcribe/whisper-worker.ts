import ortMjsUrl from "onnxruntime-web/ort-wasm-simd-threaded.asyncify.mjs?url";
import ortWasmUrl from "onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm?url";
import { revisionFor } from "../model-revisions";
import { WHISPER_SAMPLE_RATE } from "./chunking";
import type { WorkerRequest, WorkerResponse } from "./protocol";
import { createWhisperEngine, type AsrPipeline } from "./whisper-engine";

interface WorkerScope {
  onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null;
  postMessage(message: WorkerResponse): void;
}

const scope = self as unknown as WorkerScope;

async function hasWebGpu(): Promise<boolean> {
  try {
    const gpu = (navigator as Navigator & { gpu?: { requestAdapter(): Promise<unknown> } }).gpu;
    return gpu !== undefined && (await gpu.requestAdapter()) !== null;
  } catch {
    return false;
  }
}

/** Loaded lazily so the transformers.js bundle is fetched only when someone actually transcribes. */
async function loadPipeline(model: string): Promise<AsrPipeline> {
  const { pipeline, env } = await import("@huggingface/transformers");
  env.allowLocalModels = false;
  // The default wasm cache re-wraps the ORT loader in a blob: URL, which a strict script-src (no blob:) forbids; import it from its own-origin URL instead.
  env.useWasmCache = false;
  // transformers.js defaults to fetching the ONNX runtime from a CDN; serve it from this origin so the model download is the only network access.
  const onnx = env.backends.onnx;
  if (onnx.wasm) onnx.wasm.wasmPaths = { mjs: ortMjsUrl, wasm: ortWasmUrl };
  const create = (device: "webgpu" | "wasm") =>
    pipeline("automatic-speech-recognition", model, {
      revision: revisionFor(model),
      device,
      dtype: device === "webgpu" ? { encoder_model: "fp32", decoder_model_merged: "q8" } : "q8",
    });
  const pipe = (await hasWebGpu()) ? await create("webgpu").catch(() => create("wasm")) : await create("wasm");
  return pipe as unknown as AsrPipeline;
}

const engine = createWhisperEngine({ loadPipeline });

scope.onmessage = (event) => {
  const request = event.data;
  engine
    .recognise({ model: request.model, samples: request.samples, language: request.language, sampleRate: WHISPER_SAMPLE_RATE })
    .then((words) => scope.postMessage({ type: "result", id: request.id, words }))
    .catch((error: unknown) => scope.postMessage({ type: "error", id: request.id, message: error instanceof Error ? error.message : String(error) }));
};
