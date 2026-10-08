/** transformers.js stores downloaded model files in this Cache Storage bucket. */
export const MODEL_CACHE_NAME = "transformers-cache";

/** True when the model's files are already on this device, i.e. transcribing needs no download. */
export async function isModelCached(model: string): Promise<boolean> {
  try {
    if (typeof caches === "undefined" || !(await caches.has(MODEL_CACHE_NAME))) return false;
    const cache = await caches.open(MODEL_CACHE_NAME);
    return (await cache.keys()).some((request) => request.url.includes(`/${model}/`) && request.url.endsWith(".onnx"));
  } catch {
    return false;
  }
}
