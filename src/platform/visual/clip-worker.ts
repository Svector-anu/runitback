import ortMjsUrl from "onnxruntime-web/ort-wasm-simd-threaded.asyncify.mjs?url";
import ortWasmUrl from "onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm?url";
import { createClipEngine, createLoadProgress, type ImageEncoder, type TextEncoder } from "./clip-engine";
import type { EncodedBatch, WorkerRequest, WorkerResponse } from "./protocol";

interface WorkerScope {
  onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null;
  postMessage(message: WorkerResponse, transfer?: Transferable[]): void;
}

const scope = self as unknown as WorkerScope;

/** Loaded lazily so the transformers.js bundle is fetched only when someone actually searches or indexes. */
async function transformers(): Promise<typeof import("@huggingface/transformers")> {
  const library = await import("@huggingface/transformers");
  library.env.allowLocalModels = false;
  // transformers.js defaults to fetching the ONNX runtime from a CDN; serve it from this origin so the model download is the only network access.
  const onnx = library.env.backends.onnx;
  if (onnx.wasm) onnx.wasm.wasmPaths = { mjs: ortMjsUrl, wasm: ortWasmUrl };
  return library;
}

function batchOf(tensor: { data: unknown; dims: readonly number[] }): EncodedBatch {
  const dimensions = tensor.dims[tensor.dims.length - 1];
  if (!(tensor.data instanceof Float32Array) || dimensions === undefined) throw new Error("The model returned an unexpected embedding format");
  return { data: tensor.data, dimensions };
}

/** Int8-quantised weights run on the WASM backend; the WebGPU backend lacks the integer matmul kernels they need. */
const MODEL_OPTIONS = { device: "wasm", dtype: "q8" } as const;

async function loadImageEncoder(model: string, onLoad: (fraction: number) => void): Promise<ImageEncoder> {
  const { AutoProcessor, CLIPVisionModelWithProjection, RawImage } = await transformers();
  const progress_callback = createLoadProgress(onLoad);
  const [processor, vision] = await Promise.all([
    AutoProcessor.from_pretrained(model, { progress_callback }),
    CLIPVisionModelWithProjection.from_pretrained(model, { ...MODEL_OPTIONS, progress_callback }),
  ]);
  return async (images) => {
    const inputs = await processor(images.map((image) => new RawImage(image.data, image.width, image.height, 4)));
    const output = await vision(inputs);
    return batchOf(output.image_embeds);
  };
}

async function loadTextEncoder(model: string, onLoad: (fraction: number) => void): Promise<TextEncoder> {
  const { AutoTokenizer, CLIPTextModelWithProjection } = await transformers();
  const progress_callback = createLoadProgress(onLoad);
  const [tokenizer, text] = await Promise.all([
    AutoTokenizer.from_pretrained(model, { progress_callback }),
    CLIPTextModelWithProjection.from_pretrained(model, { ...MODEL_OPTIONS, progress_callback }),
  ]);
  return async (texts) => {
    const output = await text(tokenizer(texts, { padding: true, truncation: true }));
    return batchOf(output.text_embeds);
  };
}

const engine = createClipEngine({ loadImageEncoder, loadTextEncoder });

scope.onmessage = (event) => {
  const request = event.data;
  const onLoad = (fraction: number): void => scope.postMessage({ type: "loading", id: request.id, fraction });
  const run = request.type === "embed-images"
    ? engine.embedImages({ model: request.model, images: request.images, onLoad })
    : engine.embedTexts({ model: request.model, texts: request.texts, onLoad });
  run
    .then((batch) => scope.postMessage({ type: "result", id: request.id, data: batch.data, dimensions: batch.dimensions }, [batch.data.buffer]))
    .catch((error: unknown) => scope.postMessage({ type: "error", id: request.id, message: error instanceof Error ? error.message : String(error) }));
};
