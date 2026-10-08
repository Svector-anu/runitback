import { MODEL_CACHE_NAME } from "#/platform/transcribe/model-cache";

/** The quantised weights transformers.js downloads for the image and text halves of the model. */
const REQUIRED_FILES = ["/onnx/vision_model_quantized.onnx", "/onnx/text_model_quantized.onnx"] as const;

/**
 * True when both halves of the model are already on this device. Indexing needs only the image half and searching only
 * the text half, so "cached" must mean both: otherwise the second action would start a download nobody approved.
 */
export async function isClipModelCached(model: string): Promise<boolean> {
  try {
    if (typeof caches === "undefined" || !(await caches.has(MODEL_CACHE_NAME))) return false;
    const urls = (await (await caches.open(MODEL_CACHE_NAME)).keys()).map((request) => request.url);
    return REQUIRED_FILES.every((file) => urls.some((url) => url.includes(`/${model}/`) && url.endsWith(file)));
  } catch {
    return false;
  }
}
