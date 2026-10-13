import ortMjsUrl from "onnxruntime-web/ort-wasm-simd-threaded.asyncify.mjs?url";
import ortWasmUrl from "onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm?url";
import { revisionFor } from "../model-revisions";
import { SPEECHT5_DTYPE, SPEECHT5_VOCODER, SPEAKER_EMBEDDING_SIZE } from "./models";
import type { TtsRequest, TtsResponse } from "./protocol";

interface WorkerScope {
  onmessage: ((event: MessageEvent<TtsRequest>) => void) | null;
  postMessage(message: TtsResponse, transfer?: Transferable[]): void;
}

/** `generate_speech` exists on the SpeechT5 class at runtime; the library's declared type is the generic base. */
interface SpeechT5Model {
  generate_speech(inputIds: unknown, speaker: unknown, options: { vocoder: unknown }): Promise<{ waveform: { data: ArrayLike<number> } }>;
}

interface Loaded {
  speak(text: string, speaker: Float32Array): Promise<Float32Array>;
}

const scope = self as unknown as WorkerScope;
const SAMPLE_RATE = 16_000;
let loaded: Promise<Loaded> | null = null;
let currentId = 0;

/** Loaded lazily so the transformers.js bundle (and the ~105 MB of weights) are fetched only when someone generates speech. */
async function load(model: string): Promise<Loaded> {
  const { AutoTokenizer, SpeechT5ForTextToSpeech, AutoModel, Tensor, env } = await import("@huggingface/transformers");
  env.allowLocalModels = false;
  // See whisper-worker.ts: keep ORT importable from its own origin so script-src can stay free of blob:.
  env.useWasmCache = false;
  const onnx = env.backends.onnx;
  if (onnx.wasm) onnx.wasm.wasmPaths = { mjs: ortMjsUrl, wasm: ortWasmUrl };

  const files = new Map<string, { loaded: number; total: number }>();
  let best = 0;
  const progress_callback = (event: { status?: string; file?: string; loaded?: number; total?: number }): void => {
    if (event.status !== "progress" || !event.file || !event.total) return;
    files.set(event.file, { loaded: event.loaded ?? 0, total: event.total });
    let done = 0;
    let total = 0;
    for (const f of files.values()) {
      done += f.loaded;
      total += f.total;
    }
    best = Math.max(best, total > 0 ? done / total : 0);
    scope.postMessage({ type: "progress", id: currentId, fraction: best });
  };

  const tokenizer = await AutoTokenizer.from_pretrained(model, { revision: revisionFor(model) });
  const speecht5 = (await SpeechT5ForTextToSpeech.from_pretrained(model, { revision: revisionFor(model), device: "wasm", dtype: SPEECHT5_DTYPE, progress_callback })) as unknown as SpeechT5Model;
  const vocoder = await AutoModel.from_pretrained(SPEECHT5_VOCODER, { revision: revisionFor(SPEECHT5_VOCODER), device: "wasm", dtype: "q8", progress_callback });
  return {
    async speak(text, speaker) {
      const { input_ids } = tokenizer(text);
      const embedding = new Tensor("float32", speaker, [1, SPEAKER_EMBEDDING_SIZE]);
      const { waveform } = await speecht5.generate_speech(input_ids, embedding, { vocoder });
      return Float32Array.from(waveform.data);
    },
  };
}

scope.onmessage = (event) => {
  const request = event.data;
  currentId = request.id;
  void (async () => {
    try {
      loaded ??= load(request.model);
      loaded.catch(() => { loaded = null; });
      const samples = await (await loaded).speak(request.text, request.speaker);
      scope.postMessage({ type: "result", id: request.id, samples, sampleRate: SAMPLE_RATE }, [samples.buffer]);
    } catch (error) {
      scope.postMessage({ type: "error", id: request.id, message: error instanceof Error ? error.message : String(error) });
    }
  })();
};
