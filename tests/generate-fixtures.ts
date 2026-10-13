import { vi } from "vitest";

export const KEY = "inf_test_key_123456";
export const BASE = "https://api.surplusintelligence.ai";

export const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const base = { context_length: 0, created: 1, description: "", supported_parameters: [], top_provider: {} };

export const CATALOG_BODY = {
  data: [
    { ...base, id: "chat-model", name: "Chat", architecture: { input_modalities: ["text"], output_modalities: ["text"] }, pricing: { prompt: "0.1", completion: "0.1" } },
    {
      ...base, id: "img-cheap", name: "Cheap Image", architecture: { input_modalities: ["text"], output_modalities: ["image"] },
      pricing: { image: "0.01", media_unit: "image" }, supported_features: ["image", "aspect_ratio"], sizes: ["1024x768", "1024x1024"], aspect_ratios: ["1:1", "16:9"],
    },
    {
      ...base, id: "img-dear", name: "Dear Image", architecture: { input_modalities: ["text"], output_modalities: ["image"] },
      pricing: { image: "1.50", media_unit: "image" }, supported_features: ["image"], sizes: ["1024x1024"],
    },
    {
      ...base, id: "img-tokens", name: "Token Image", architecture: { input_modalities: ["text"], output_modalities: ["image"] },
      pricing: { prompt: "0", completion: "0" }, supported_features: ["image", "token_metered"], sizes: ["1024x1024"],
    },
    {
      ...base, id: "img-edit", name: "Edit Image", architecture: { input_modalities: ["text"], output_modalities: ["image"] },
      pricing: { image: "0.02", media_unit: "image" }, supported_features: ["image", "image_edit", "image-to-image"], sizes: ["1024x1024"],
    },
    {
      ...base, id: "img-legacy", name: "Old Image", architecture: { input_modalities: ["text"], output_modalities: ["image"] },
      pricing: { image: "0.001", media_unit: "image" }, supported_features: ["image", "legacy"], sizes: ["1024x1024"],
    },
    {
      ...base, id: "vid-t2v", name: "Text Video", architecture: { input_modalities: ["text"], output_modalities: ["video"] },
      pricing: { image: "0.32", media_unit: "job" }, supported_features: ["video", "async", "text-to-video"], aspect_ratios: ["16:9", "9:16"], durations_seconds: [4, 8],
    },
    {
      ...base, id: "vid-i2v", name: "Image Video", architecture: { input_modalities: ["text"], output_modalities: ["video"] },
      pricing: { image: "0.1", media_unit: "job" }, supported_features: ["video", "async", "image-to-video"], aspect_ratios: ["16:9"],
    },
    {
      ...base, id: "mus-a", name: "Music A", architecture: { input_modalities: ["text"], output_modalities: ["music"] },
      pricing: { image: "0.03", media_unit: "job" }, supported_features: ["music", "async"], durations_seconds: [60, 90],
    },
    {
      ...base, id: "mus-tts", name: "Music-route TTS", architecture: { input_modalities: ["text"], output_modalities: ["music"] },
      pricing: { image: "0.12", media_unit: "job" }, supported_features: ["audio", "async", "tts"],
    },
    {
      ...base, id: "tts-a", name: "Voice A", architecture: { input_modalities: ["text"], output_modalities: ["audio"] },
      pricing: { image: "0.0035", media_unit: "1K characters" }, supported_features: ["audio", "voices"], voices: ["alloy", "echo"],
    },
  ],
};

export type Handler = (url: string, init: RequestInit) => Response | Promise<Response>;

export interface Call { url: string; method: string; headers: Record<string, string>; body: unknown }

/** A fetch that answers from `routes` in order of registration, matching on "METHOD url-suffix", and records every call. */
export function fakeFetch(routes: Record<string, Handler | Handler[]>): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const queues = new Map(Object.entries(routes).map(([k, v]) => [k, Array.isArray(v) ? [...v] : [v]]));
  const impl = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    const method = init.method ?? "GET";
    const headers = Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
    calls.push({ url, method, headers, body: typeof init.body === "string" ? JSON.parse(init.body) : init.body });
    const key = [...queues.keys()].find((k) => k === `${method} ${url.replace(BASE, "")}`);
    const queue = key ? queues.get(key) : undefined;
    const handler = queue && (queue.length > 1 ? queue.shift() : queue[0]);
    if (!handler) throw new TypeError(`unexpected request ${method} ${url}`);
    return handler(url, init);
  });
  return { fetch: impl as unknown as typeof fetch, calls };
}

export const json = (status: number, body: unknown, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

export const bytes = (data: string, type: string, status = 200): Response => new Response(data, { status, headers: { "content-type": type } });
