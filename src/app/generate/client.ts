import { parseCatalog, type GenerateKind, type GenerateModel } from "./catalog";

export const SURPLUS_BASE_URL = "https://api.surplusintelligence.ai";
export const SURPLUS_SITE_URL = "https://www.surplusintelligence.ai";

export type GenerateErrorCode =
  | "unauthorized" | "insufficient-credit" | "invalid-request" | "rate-limited" | "no-sellers" | "unavailable"
  | "network" | "timeout" | "failed" | "expired" | "cancelled" | "download" | "bad-response";

/** A failure written for the person using the panel (or the model reading a tool result). Never contains the API key. */
export class GenerateError extends Error {
  constructor(readonly code: GenerateErrorCode, message: string, readonly retryable = false) {
    super(message);
    this.name = "GenerateError";
  }
}

export interface GenerateRequest {
  kind: GenerateKind;
  model: GenerateModel;
  prompt: string;
  /** Image: one of the model's `sizes`, e.g. "1536x1024". */
  size?: string;
  /** Video: one of the model's `aspectRatios`. */
  aspectRatio?: string;
  /** Video and music: seconds, one of the model's `durations`. */
  durationSeconds?: number;
  /** Speech: one of the model's `voices`. */
  voice?: string;
}

export type GeneratePhase = "submitting" | "queued" | "running" | "downloading";

export interface GenerateProgress {
  phase: GeneratePhase;
  /** 0..1 when the gateway reports it. */
  fraction?: number;
  elapsedMs: number;
  /** The gateway's own quote for this job, once submit has returned it. */
  quotedUsd?: number;
  /** The most the job can be charged. */
  ceilingUsd?: number;
}

export interface GeneratedMedia {
  blob: Blob;
  mimeType: string;
  extension: string;
  kind: GenerateKind;
  modelId: string;
  prompt: string;
  quotedUsd?: number;
  chargedUsd?: number;
}

export interface GenerateOptions {
  apiKey: string;
  request: GenerateRequest;
  fetch?: typeof fetch;
  signal?: AbortSignal;
  onProgress?: (progress: GenerateProgress) => void;
  /** Injected so tests do not wait in real time. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  now?: () => number;
  newIdempotencyKey?: () => string;
}

export const IMAGE_TIMEOUT_MS = 120_000;
export const SPEECH_TIMEOUT_MS = 60_000;
export const DOWNLOAD_TIMEOUT_MS = 120_000;
/** Longest the panel waits for an asynchronous job; the gateway's own `expires_at` can shorten it. */
export const JOB_TIMEOUT_MS: Readonly<Record<"video" | "music", number>> = { video: 30 * 60_000, music: 15 * 60_000 };
export const POLL_START_MS = 2_000;
export const POLL_MAX_MS = 10_000;
const MAX_PROMPT_CHARS = 2000;
const MICRO = 1_000_000;

const EXTENSIONS: Readonly<Record<string, string>> = {
  "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp",
  "video/mp4": "mp4", "video/webm": "webm", "video/quicktime": "mov",
  "audio/mpeg": "mp3", "audio/mp3": "mp3", "audio/wav": "wav", "audio/x-wav": "wav", "audio/wave": "wav", "audio/ogg": "ogg",
  "audio/flac": "flac", "audio/aac": "aac", "audio/mp4": "m4a", "audio/webm": "weba",
};
const TOP_LEVEL: Readonly<Record<GenerateKind, string>> = { image: "image/", video: "video/", music: "audio/", speech: "audio/" };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);
const microToUsd = (v: unknown): number | undefined => {
  const n = typeof v === "string" || typeof v === "number" ? Number(v) : NaN;
  return Number.isFinite(n) && n >= 0 ? n / MICRO : undefined;
};

function redact(text: string, apiKey: string): string {
  return apiKey ? text.replaceAll(apiKey, "[key]") : text;
}

function sleepReal(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new GenerateError("cancelled", "Cancelled.")); return; }
    const timer = setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolve(); }, ms);
    const onAbort = (): void => { clearTimeout(timer); reject(new GenerateError("cancelled", "Cancelled.")); };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** An AbortSignal that fires when `parent` does or after `ms`, plus a way to tell the two apart. */
function withTimeout(parent: AbortSignal | undefined, ms: number): { signal: AbortSignal; timedOut: () => boolean; dispose: () => void } {
  const controller = new AbortController();
  let timedOut = false;
  const onParent = (): void => controller.abort();
  if (parent?.aborted) controller.abort();
  parent?.addEventListener("abort", onParent, { once: true });
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, ms);
  return { signal: controller.signal, timedOut: () => timedOut, dispose: () => { clearTimeout(timer); parent?.removeEventListener("abort", onParent); } };
}

interface ErrorBody { code: string; message: string }

async function readErrorBody(response: Response): Promise<ErrorBody> {
  try {
    const body: unknown = await response.json();
    const error = isRecord(body) && isRecord(body.error) ? body.error : {};
    return { code: str(error.code) ?? str(error.type) ?? "", message: (str(error.message) ?? "").slice(0, 240) };
  } catch {
    return { code: "", message: "" };
  }
}

const CREDIT = /credit|balance|allowance|funds|payment/i;

/** Maps a non-2xx response to the error the person should see. The gateway's text is quoted, never the key. */
export async function errorFromResponse(response: Response, apiKey: string): Promise<GenerateError> {
  const { code, message } = await readErrorBody(response);
  const detail = message ? ` (${redact(message, apiKey)})` : "";
  const { status } = response;
  if (status === 401 || status === 403) {
    return new GenerateError("unauthorized", `Surplus rejected this key (${status}). Check that you pasted the whole inf_ key and that it has not been revoked.`);
  }
  if (status === 402 || ((status === 400) && (CREDIT.test(code) || CREDIT.test(message)))) {
    return new GenerateError("insufficient-credit", `Not enough Surplus credit (${status}). Add credit in your Surplus account and try again; nothing was charged${detail}.`);
  }
  if (status === 429) {
    const wait = Number(response.headers.get("retry-after"));
    return new GenerateError("rate-limited", `Surplus is rate limiting this key (429).${Number.isFinite(wait) && wait > 0 ? ` Try again in about ${Math.ceil(wait)} s.` : " Wait a moment and try again."}`, true);
  }
  if (status === 404 || code === "no_sellers_for_model" || code === "model_not_found") {
    return new GenerateError("no-sellers", `No provider can serve this model right now (${status}${code ? ` ${code}` : ""}). Pick another model.`);
  }
  if (status === 400) return new GenerateError("invalid-request", `Surplus refused the request (400)${detail || ". Try a shorter or different prompt, or another option"}.`);
  if (status === 503 || status >= 500) return new GenerateError("unavailable", `Surplus or its provider is unavailable (${status}). Try again shortly or pick another model.`, true);
  return new GenerateError("failed", `Surplus returned an unexpected error (${status})${detail}.`);
}

async function send(input: {
  fetchImpl: typeof fetch; url: string; init: RequestInit; apiKey: string; signal: AbortSignal | undefined; timeoutMs: number; what: string;
}): Promise<Response> {
  const { fetchImpl, url, init, apiKey, signal, timeoutMs, what } = input;
  const guard = withTimeout(signal, timeoutMs);
  try {
    const response = await fetchImpl(url, { ...init, signal: guard.signal });
    if (signal?.aborted) throw new GenerateError("cancelled", "Cancelled.");
    return response;
  } catch (error) {
    if (error instanceof GenerateError) throw error;
    if (signal?.aborted) throw new GenerateError("cancelled", "Cancelled.");
    if (guard.timedOut()) throw new GenerateError("timeout", `${what} timed out after ${Math.round(timeoutMs / 1000)} s. Nothing was added to your project.`, true);
    throw new GenerateError("network", `Could not reach Surplus. Check your connection, VPN or ad blocker and try again. ${redact(error instanceof Error ? error.message : "", apiKey)}`.trim(), true);
  } finally {
    guard.dispose();
  }
}

/** Reads the body under the same timeout the request had; a stalled download must not hang the panel. */
async function readBlob(response: Response, signal: AbortSignal | undefined, what: string): Promise<Blob> {
  const guard = withTimeout(signal, DOWNLOAD_TIMEOUT_MS);
  try {
    return await Promise.race([
      response.blob(),
      new Promise<never>((_, reject) => guard.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true })),
    ]);
  } catch {
    if (signal?.aborted) throw new GenerateError("cancelled", "Cancelled.");
    throw new GenerateError(guard.timedOut() ? "timeout" : "download", `Could not download the ${what}. Generated files expire after a few hours, so try again soon.`, true);
  } finally {
    guard.dispose();
  }
}

function sniffImage(bytes: Uint8Array): string | null {
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return "image/jpeg";
  if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 && bytes[8] === 0x57) return "image/webp";
  return null;
}

function decodeBase64(data: string): Uint8Array {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function checkMime(kind: GenerateKind, declared: string | null | undefined, what: string): { mimeType: string; extension: string } {
  const mimeType = (declared ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
  if (!mimeType.startsWith(TOP_LEVEL[kind])) {
    throw new GenerateError("bad-response", `Surplus returned ${mimeType || "an unknown file type"} instead of ${what}. Nothing was added to your project.`);
  }
  return { mimeType, extension: EXTENSIONS[mimeType] ?? (mimeType.slice(TOP_LEVEL[kind].length).replace(/[^a-z0-9]/g, "") || "bin") };
}

function authHeaders(apiKey: string, extra: Record<string, string> = {}): Record<string, string> {
  return { authorization: `Bearer ${apiKey}`, ...extra };
}

function validatePrompt(request: GenerateRequest): void {
  if (request.prompt.trim() === "") throw new GenerateError("invalid-request", "Write a prompt first.");
  if (request.prompt.length > MAX_PROMPT_CHARS && request.kind !== "speech") {
    throw new GenerateError("invalid-request", `The prompt is ${request.prompt.length} characters; Surplus accepts at most ${MAX_PROMPT_CHARS}.`);
  }
}

async function generateImage(options: GenerateOptions, fetchImpl: typeof fetch): Promise<GeneratedMedia> {
  const { apiKey, request, signal, onProgress } = options;
  const now = options.now ?? Date.now;
  const started = now();
  onProgress?.({ phase: "submitting", elapsedMs: 0 });
  const response = await send({
    fetchImpl, url: `${SURPLUS_BASE_URL}/v1/images/generations`, apiKey, signal, timeoutMs: IMAGE_TIMEOUT_MS, what: "Image generation",
    init: {
      method: "POST", headers: authHeaders(apiKey, { "content-type": "application/json" }),
      body: JSON.stringify({ model: request.model.id, prompt: request.prompt, n: 1, response_format: "b64_json", ...(request.size ? { size: request.size } : {}) }),
    },
  });
  if (!response.ok) throw await errorFromResponse(response, apiKey);
  const body: unknown = await response.json().catch(() => null);
  const first = isRecord(body) && Array.isArray(body.data) && isRecord(body.data[0]) ? body.data[0] : null;
  const b64 = str(first?.b64_json);
  const charged = microToUsd(response.headers.get("x-si-buyer-cost-micro"));
  const finish = (blob: Blob, mime: string): GeneratedMedia => ({
    blob, ...checkMime("image", mime, "an image"), kind: "image", modelId: request.model.id, prompt: request.prompt, ...(charged !== undefined ? { chargedUsd: charged } : {}),
  });
  if (b64) {
    let bytes: Uint8Array;
    try { bytes = decodeBase64(b64); } catch { throw new GenerateError("bad-response", "Surplus returned image data that could not be decoded."); }
    const mime = sniffImage(bytes);
    if (!mime) throw new GenerateError("bad-response", "Surplus returned data that is not a PNG, JPEG or WebP image.");
    return finish(new Blob([bytes as BlobPart], { type: mime }), mime);
  }
  const url = str(first?.url);
  if (!url) throw new GenerateError("bad-response", "Surplus answered without an image.");
  onProgress?.({ phase: "downloading", elapsedMs: now() - started });
  const download = await send({ fetchImpl, url, init: { method: "GET" }, apiKey, signal, timeoutMs: DOWNLOAD_TIMEOUT_MS, what: "Image download" });
  if (!download.ok) throw new GenerateError("download", `Could not download the image (${download.status}).`, true);
  return finish(await readBlob(download, signal, "image"), download.headers.get("content-type") ?? "");
}

async function generateSpeech(options: GenerateOptions, fetchImpl: typeof fetch): Promise<GeneratedMedia> {
  const { apiKey, request, signal, onProgress } = options;
  onProgress?.({ phase: "submitting", elapsedMs: 0 });
  const response = await send({
    fetchImpl, url: `${SURPLUS_BASE_URL}/v1/audio/speech`, apiKey, signal, timeoutMs: SPEECH_TIMEOUT_MS, what: "Speech generation",
    init: {
      method: "POST", headers: authHeaders(apiKey, { "content-type": "application/json" }),
      body: JSON.stringify({ model: request.model.id, input: request.prompt, response_format: "mp3", ...(request.voice ? { voice: request.voice } : {}) }),
    },
  });
  if (!response.ok) throw await errorFromResponse(response, apiKey);
  const blob = await readBlob(response, signal, "audio");
  const { mimeType, extension } = checkMime("speech", response.headers.get("content-type") ?? blob.type, "audio");
  const charged = microToUsd(response.headers.get("x-si-buyer-cost-micro"));
  return { blob: new Blob([blob], { type: mimeType }), mimeType, extension, kind: "speech", modelId: request.model.id, prompt: request.prompt, ...(charged !== undefined ? { chargedUsd: charged } : {}) };
}

interface Job {
  id: string;
  pollUrl: string;
  token: string | undefined;
  quotedUsd?: number;
  ceilingUsd?: number;
  expiresAtMs?: number;
}

function parseJob(body: unknown, route: string): Job {
  if (!isRecord(body)) throw new GenerateError("bad-response", "Surplus answered the job request with something unreadable.");
  const id = str(body.id);
  if (!id) throw new GenerateError("bad-response", "Surplus did not return a job id.");
  const poll = str(body.poll_url);
  const pollUrl = poll?.startsWith("/v1/") ? `${SURPLUS_BASE_URL}${poll}` : `${SURPLUS_BASE_URL}${route}/${encodeURIComponent(id)}`;
  const quoted = microToUsd(body.estimated_cost_usdc);
  const ceiling = microToUsd(body.max_cost_usdc);
  const expires = typeof body.expires_at === "number" ? body.expires_at * 1000 : undefined;
  return { id, pollUrl, token: str(body.job_token), ...(quoted !== undefined ? { quotedUsd: quoted } : {}), ...(ceiling !== undefined ? { ceilingUsd: ceiling } : {}), ...(expires !== undefined ? { expiresAtMs: expires } : {}) };
}

function jobHeaders(apiKey: string, job: Job): Record<string, string> {
  return authHeaders(apiKey, job.token ? { "x-job-token": job.token } : {});
}

function jobFailure(body: Record<string, unknown>, status: string): GenerateError {
  const error = isRecord(body.error) ? body.error : {};
  const message = str(error.message);
  const type = str(error.type);
  const retryable = typeof error.retryable === "boolean" ? error.retryable : type !== "invalid_request";
  const charge = "You were not charged.";
  if (status === "expired" || type === "expired") return new GenerateError("expired", `The job expired before it finished. ${charge}`, true);
  if (status === "canceled") return new GenerateError("cancelled", "The job was cancelled.");
  return new GenerateError("failed", `Generation failed${message ? `: ${message.slice(0, 200)}` : ""}. ${charge}${retryable ? " Trying again, or another model, may work." : " Change the prompt or options."}`, retryable);
}

async function cancelJob(fetchImpl: typeof fetch, route: string, apiKey: string, job: Job): Promise<void> {
  try {
    await fetchImpl(`${SURPLUS_BASE_URL}${route}/${encodeURIComponent(job.id)}`, { method: "DELETE", headers: jobHeaders(apiKey, job) });
  } catch {
    // Best effort: the job also expires on its own.
  }
}

async function generateJob(options: GenerateOptions, fetchImpl: typeof fetch): Promise<GeneratedMedia> {
  const { apiKey, request, signal, onProgress } = options;
  const kind = request.kind === "video" ? "video" : "music";
  const route = kind === "video" ? "/v1/video/generations" : "/v1/music/generations";
  const sleep = options.sleep ?? sleepReal;
  const now = options.now ?? Date.now;
  const started = now();
  onProgress?.({ phase: "submitting", elapsedMs: 0 });

  const body = {
    model: request.model.id, prompt: request.prompt,
    ...(request.durationSeconds !== undefined ? { duration_seconds: request.durationSeconds } : {}),
    ...(kind === "video" && request.aspectRatio ? { aspect_ratio: request.aspectRatio } : {}),
  };
  const submit = await send({
    fetchImpl, url: `${SURPLUS_BASE_URL}${route}`, apiKey, signal, timeoutMs: 60_000, what: "Submitting the job",
    init: { method: "POST", headers: authHeaders(apiKey, { "content-type": "application/json", "idempotency-key": (options.newIdempotencyKey ?? (() => crypto.randomUUID()))() }), body: JSON.stringify(body) },
  });
  if (!submit.ok) throw await errorFromResponse(submit, apiKey);
  const job = parseJob(await submit.json().catch(() => null), route);
  const deadline = Math.min(started + JOB_TIMEOUT_MS[kind], job.expiresAtMs !== undefined ? job.expiresAtMs + 30_000 : Infinity);
  const report = (phase: "queued" | "running", fraction?: number): void =>
    onProgress?.({ phase, ...(fraction !== undefined ? { fraction } : {}), elapsedMs: now() - started, ...(job.quotedUsd !== undefined ? { quotedUsd: job.quotedUsd } : {}), ...(job.ceilingUsd !== undefined ? { ceilingUsd: job.ceilingUsd } : {}) });
  report("queued");

  let interval = POLL_START_MS;
  let consecutiveFailures = 0;
  for (;;) {
    try {
      await sleep(interval, signal);
    } catch (error) {
      void cancelJob(fetchImpl, route, apiKey, job);
      throw error;
    }
    if (now() > deadline) {
      void cancelJob(fetchImpl, route, apiKey, job);
      throw new GenerateError("timeout", `The ${kind === "video" ? "video" : "track"} was not ready after ${Math.round((now() - started) / 60_000)} minutes, so the job was cancelled. You are charged only for work that completed.`, true);
    }
    let poll: Response;
    try {
      poll = await send({ fetchImpl, url: job.pollUrl, init: { method: "GET", headers: jobHeaders(apiKey, job) }, apiKey, signal, timeoutMs: 30_000, what: "Checking the job" });
    } catch (error) {
      if (error instanceof GenerateError && error.code === "cancelled") { void cancelJob(fetchImpl, route, apiKey, job); throw error; }
      if (++consecutiveFailures >= 4) throw error;
      continue;
    }
    if (poll.status === 429 || poll.status >= 500) {
      if (++consecutiveFailures >= 4) throw await errorFromResponse(poll, apiKey);
      interval = Math.min(Math.round(interval * 1.5), POLL_MAX_MS);
      continue;
    }
    if (!poll.ok) throw await errorFromResponse(poll, apiKey);
    consecutiveFailures = 0;
    const status: unknown = await poll.json().catch(() => null);
    if (!isRecord(status)) throw new GenerateError("bad-response", "Surplus answered the status check with something unreadable.");
    const state = str(status.status) ?? "";
    if (state === "succeeded" || state === "completed") return downloadResult({ options, fetchImpl, job, status, started });
    if (state === "failed" || state === "canceled" || state === "expired") throw jobFailure(status, state);
    report(state === "running" || state === "submitted" ? "running" : "queued", typeof status.progress === "number" ? Math.min(1, Math.max(0, status.progress)) : undefined);
    interval = Math.min(Math.round(interval * 1.5), POLL_MAX_MS);
  }
}

async function downloadResult(input: { options: GenerateOptions; fetchImpl: typeof fetch; job: Job; status: Record<string, unknown>; started: number }): Promise<GeneratedMedia> {
  const { options, fetchImpl, job, status } = input;
  const { apiKey, request, signal, onProgress } = options;
  const now = options.now ?? Date.now;
  const results = Array.isArray(status.results) ? status.results : [];
  const first = results.find(isRecord);
  const url = str(first?.url);
  if (!url) throw new GenerateError("bad-response", "The job finished but returned no file.");
  onProgress?.({ phase: "downloading", elapsedMs: now() - input.started });
  const ours = new URL(url, SURPLUS_BASE_URL).origin === SURPLUS_BASE_URL;
  const download = await send({
    fetchImpl, url, apiKey, signal, timeoutMs: DOWNLOAD_TIMEOUT_MS, what: "The download",
    init: { method: "GET", redirect: "follow", ...(ours ? { headers: jobHeaders(apiKey, job) } : {}) },
  });
  if (!download.ok) throw new GenerateError("download", `Could not download the finished file (${download.status}). Generated files expire a few hours after they finish; generate it again if it is gone.`, true);
  const blob = await readBlob(download, signal, request.kind === "video" ? "video" : "audio");
  const declared = str(first?.content_type) ?? download.headers.get("content-type") ?? blob.type;
  const { mimeType, extension } = checkMime(request.kind, declared, request.kind === "video" ? "a video" : "audio");
  const usage = isRecord(status.usage) ? status.usage : {};
  const charged = microToUsd(usage.buyer_cost_usdc);
  return {
    blob: new Blob([blob], { type: mimeType }), mimeType, extension, kind: request.kind, modelId: request.model.id, prompt: request.prompt,
    ...(job.quotedUsd !== undefined ? { quotedUsd: job.quotedUsd } : {}), ...(charged !== undefined ? { chargedUsd: charged } : {}),
  };
}

/**
 * Generates one file. Images and speech are a single request; video and music are asynchronous jobs that are submitted,
 * polled (2 s backing off to 10 s) and downloaded with the job token. Aborting cancels the job best-effort.
 */
export async function generateMedia(options: GenerateOptions): Promise<GeneratedMedia> {
  const fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
  if (options.apiKey.trim() === "") throw new GenerateError("unauthorized", "Add your Surplus key first.");
  validatePrompt(options.request);
  switch (options.request.kind) {
    case "image": return generateImage(options, fetchImpl);
    case "speech": return generateSpeech(options, fetchImpl);
    case "video":
    case "music": return generateJob(options, fetchImpl);
  }
}

export async function fetchCatalog(input: { fetch?: typeof fetch; signal?: AbortSignal } = {}): Promise<GenerateModel[]> {
  const fetchImpl = input.fetch ?? globalThis.fetch.bind(globalThis);
  const response = await send({
    fetchImpl, url: `${SURPLUS_BASE_URL}/v1/models`, init: { method: "GET" }, apiKey: "", signal: input.signal, timeoutMs: 30_000, what: "Loading the model list",
  });
  if (!response.ok) throw await errorFromResponse(response, "");
  const models = parseCatalog(await response.json().catch(() => null));
  if (models.length === 0) throw new GenerateError("bad-response", "Surplus returned a model list with no usable generation models.");
  return models;
}

export type SurplusKeyCheck = { ok: true } | { ok: false; reason: GenerateErrorCode; message: string };

/** `GET /v1/buyer/me` needs the key and costs nothing, unlike `/v1/models`, which is public and accepts any key. */
export async function checkSurplusKey(input: { apiKey: string; fetch?: typeof fetch; signal?: AbortSignal }): Promise<SurplusKeyCheck> {
  const fetchImpl = input.fetch ?? globalThis.fetch.bind(globalThis);
  try {
    const response = await send({
      fetchImpl, url: `${SURPLUS_BASE_URL}/v1/buyer/me`, init: { method: "GET", headers: authHeaders(input.apiKey) }, apiKey: input.apiKey, signal: input.signal, timeoutMs: 20_000, what: "The key check",
    });
    if (response.ok) return { ok: true };
    const error = await errorFromResponse(response, input.apiKey);
    return { ok: false, reason: error.code, message: error.message };
  } catch (error) {
    if (error instanceof GenerateError && error.code !== "cancelled") return { ok: false, reason: error.code, message: error.message };
    throw error;
  }
}
