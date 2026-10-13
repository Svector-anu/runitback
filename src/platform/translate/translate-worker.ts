import ortMjsUrl from "onnxruntime-web/ort-wasm-simd-threaded.asyncify.mjs?url";
import ortWasmUrl from "onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm?url";
import { revisionFor } from "../model-revisions";
import type { TranslateRequest, TranslateResponse } from "./protocol";

interface WorkerScope {
  onmessage: ((event: MessageEvent<TranslateRequest>) => void) | null;
  postMessage(message: TranslateResponse): void;
}

type TranslationPipe = (texts: string[], options: Record<string, unknown>) => Promise<Array<{ translation_text: string }>>;

const scope = self as unknown as WorkerScope;
const loaded = new Map<string, Promise<TranslationPipe>>();
const MAX_NEW_TOKENS = 200;

/** Loaded lazily so the transformers.js bundle is fetched only when someone translates. */
async function loadPipeline(model: string): Promise<TranslationPipe> {
  const { pipeline, env } = await import("@huggingface/transformers");
  env.allowLocalModels = false;
  // See whisper-worker.ts: keep ORT importable from its own origin so script-src can stay free of blob:.
  env.useWasmCache = false;
  const onnx = env.backends.onnx;
  if (onnx.wasm) onnx.wasm.wasmPaths = { mjs: ortMjsUrl, wasm: ortWasmUrl };
  const pipe = await pipeline("translation", model, { revision: revisionFor(model), device: "wasm", dtype: "q8" });
  return pipe as unknown as TranslationPipe;
}

scope.onmessage = (event) => {
  const request = event.data;
  void (async () => {
    try {
      let pipe = loaded.get(request.model);
      if (!pipe) {
        pipe = loadPipeline(request.model);
        loaded.set(request.model, pipe);
        pipe.catch(() => loaded.delete(request.model));
      }
      const output = await (await pipe)(request.texts, { max_new_tokens: MAX_NEW_TOKENS });
      scope.postMessage({ type: "result", id: request.id, texts: output.map((o) => o.translation_text) });
    } catch (error) {
      scope.postMessage({ type: "error", id: request.id, message: error instanceof Error ? error.message : String(error) });
    }
  })();
};
