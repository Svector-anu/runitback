import {
  ModelError, ZERO_USAGE, redactSecrets,
  type AssistantBlock, type ImageBlock, type ModelClient, type ModelMessage, type ModelRequest, type ModelResponse, type StopReason,
  type TextBlock, type TokenUsage, type ToolResultBlock,
} from "./model-client";

export const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";

const SK_KEY_PATTERN = /sk-[A-Za-z0-9_-]{8,}/g;
const IMAGE_ERROR_PATTERN = /image|vision|multimodal|multi-modal|modalit/i;
const IMAGES_OMITTED_NOTE = "[image omitted: this model endpoint does not accept images; rely on the text description]";

/** `redactSecrets` plus OpenAI-style `sk-` keys. */
export function redactProviderSecrets(text: string, apiKey?: string): string {
  return redactSecrets(text, apiKey).replace(SK_KEY_PATTERN, "[redacted]");
}

export interface OpenAiClientOptions {
  apiKey: string;
  /** OpenAI-compatible API root that serves `/chat/completions`, e.g. `https://api.openai.com/v1`. */
  baseUrl?: string;
  fetch?: typeof fetch;
  /** Parameter carrying the completion limit. Newer OpenAI models reject `max_tokens`; some compatible servers only know it. */
  maxTokensParam?: "max_completion_tokens" | "max_tokens";
  /** Extra top-level body fields, e.g. `{ reasoning_effort: "low" }`. */
  extraBody?: Record<string, unknown>;
  /** Attempts after the first for 429, 5xx and network failures. */
  maxRetries?: number;
  retryDelayMs?: number;
}

interface WireToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

type WireContentPart = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };

type WireMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string | WireContentPart[] }
  | { role: "assistant"; content: string | null; tool_calls?: WireToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

const dataUrl = (image: ImageBlock): string => `data:${image.mediaType};base64,${image.base64}`;

function toolMessageText(block: ToolResultBlock, imagesAllowed: boolean): { text: string; images: ImageBlock[] } {
  const parts: string[] = [];
  const images: ImageBlock[] = [];
  for (const inner of block.content) {
    if (inner.type === "text") parts.push(inner.text);
    else if (imagesAllowed) {
      images.push(inner);
      parts.push(`[image ${images.length} of this result is attached in the user message that follows]`);
    } else parts.push(IMAGES_OMITTED_NOTE);
  }
  const text = parts.join("\n");
  return { text: block.isError ? `Error: ${text}` : text, images };
}

export function toWireMessages(system: string, messages: ReadonlyArray<ModelMessage>, imagesAllowed: boolean): WireMessage[] {
  const wire: WireMessage[] = [{ role: "system", content: system }];
  for (const message of messages) {
    if (message.role === "assistant") {
      const text = message.content.filter((b): b is TextBlock => b.type === "text").map((b) => b.text).join("\n");
      const toolCalls: WireToolCall[] = message.content.flatMap((b) =>
        b.type === "tool_use" ? [{ id: b.id, type: "function" as const, function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) } }] : []);
      wire.push({ role: "assistant", content: text || (toolCalls.length > 0 ? null : ""), ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}) });
      continue;
    }
    const followUp: WireContentPart[] = [];
    // A tool message must directly follow the assistant tool_calls, so every result goes first and images trail in one user message.
    for (const block of message.content) {
      if (block.type !== "tool_result") continue;
      const { text, images } = toolMessageText(block, imagesAllowed);
      wire.push({ role: "tool", tool_call_id: block.toolUseId, content: text });
      if (images.length > 0) {
        followUp.push({ type: "text", text: `Image output of tool call ${block.toolUseId}:` });
        for (const image of images) followUp.push({ type: "image_url", image_url: { url: dataUrl(image) } });
      }
    }
    for (const block of message.content) {
      if (block.type === "text") followUp.push({ type: "text", text: block.text });
      else if (block.type === "image") followUp.push(imagesAllowed ? { type: "image_url", image_url: { url: dataUrl(block) } } : { type: "text", text: IMAGES_OMITTED_NOTE });
    }
    if (followUp.length > 0) wire.push({ role: "user", content: followUp });
  }
  return wire;
}

function toStopReason(reason: string | null | undefined, hasToolCalls: boolean): StopReason {
  if (reason === "tool_calls" || reason === "function_call" || hasToolCalls) return "tool_use";
  if (reason === "stop") return "end_turn";
  if (reason === "length") return "max_tokens";
  return "other";
}

interface WireUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number } | null;
}

function toUsage(usage: WireUsage | null | undefined): TokenUsage {
  if (!usage) return ZERO_USAGE;
  const cached = usage.prompt_tokens_details?.cached_tokens ?? 0;
  return {
    inputTokens: Math.max(0, (usage.prompt_tokens ?? 0) - cached),
    outputTokens: usage.completion_tokens ?? 0,
    cacheReadTokens: cached,
    cacheCreationTokens: 0,
  };
}

interface Accumulator {
  text: string;
  calls: Map<number, { id: string; name: string; args: string }>;
  finishReason: string | null;
  usage: WireUsage | null;
}

interface WireDelta {
  content?: string | null;
  tool_calls?: Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }>;
}

interface WireChunk {
  choices?: Array<{ delta?: WireDelta; message?: WireDelta; finish_reason?: string | null }>;
  usage?: WireUsage | null;
  error?: { message?: string };
}

function absorb(acc: Accumulator, chunk: WireChunk, onTextDelta?: (delta: string) => void): void {
  if (chunk.usage) acc.usage = chunk.usage;
  const choice = chunk.choices?.[0];
  if (!choice) return;
  if (choice.finish_reason) acc.finishReason = choice.finish_reason;
  const delta = choice.delta ?? choice.message;
  if (!delta) return;
  if (delta.content) {
    acc.text += delta.content;
    onTextDelta?.(delta.content);
  }
  for (const [position, call] of (delta.tool_calls ?? []).entries()) {
    const index = call.index ?? position;
    const entry = acc.calls.get(index) ?? { id: "", name: "", args: "" };
    if (call.id) entry.id = call.id;
    if (call.function?.name) entry.name += call.function.name;
    if (call.function?.arguments) entry.args += call.function.arguments;
    acc.calls.set(index, entry);
  }
}

async function readEventStream(body: ReadableStream<Uint8Array>, acc: Accumulator, onTextDelta?: (delta: string) => void): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const flushLine = (line: string): void => {
    if (!line.startsWith("data:")) return;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") return;
    let chunk: WireChunk;
    try {
      chunk = JSON.parse(payload) as WireChunk;
    } catch {
      return;
    }
    if (chunk.error) throw new ModelError(`The model stream reported an error: ${chunk.error.message ?? "unknown"}`);
    absorb(acc, chunk, onTextDelta);
  };
  for (;;) {
    const { done, value } = await reader.read();
    if (value) buffer += decoder.decode(value, { stream: !done });
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      flushLine(buffer.slice(0, newline).replace(/\r$/, ""));
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf("\n");
    }
    if (done) break;
  }
  flushLine(buffer.replace(/\r$/, ""));
}

function parseArguments(raw: string): unknown {
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return { _unparsedArguments: raw };
  }
}

function toContent(acc: Accumulator): AssistantBlock[] {
  const content: AssistantBlock[] = [];
  if (acc.text) content.push({ type: "text", text: acc.text });
  const ordered = [...acc.calls.entries()].sort(([a], [b]) => a - b);
  for (const [index, call] of ordered) {
    content.push({ type: "tool_use", id: call.id || `call_${index}`, name: call.name, input: parseArguments(call.args) });
  }
  return content;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || error.name === "APIUserAbortError");
}

const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (ms <= 0) return resolve();
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
  });

async function errorDetail(response: Response, apiKey: string): Promise<string> {
  const raw = await response.text().catch(() => "");
  let detail = raw;
  try {
    const parsed = JSON.parse(raw) as { error?: { message?: string } | string; message?: string };
    detail = (typeof parsed.error === "string" ? parsed.error : parsed.error?.message) ?? parsed.message ?? raw;
  } catch {
    // Not JSON: use the raw body.
  }
  return redactProviderSecrets(detail.slice(0, 500), apiKey);
}

class HttpFailure extends Error {
  constructor(readonly status: number, readonly detail: string) {
    super(detail);
  }
}

function describeHttpFailure(failure: HttpFailure): ModelError {
  const { status, detail } = failure;
  if (status === 401 || status === 403) {
    return new ModelError(`The API key was rejected (HTTP ${status}): ${detail}. Check the key and the endpoint.`, status);
  }
  if (status === 429) return new ModelError(`The model provider rate limit was reached (HTTP 429). Wait a moment and try again.${detail ? ` ${detail}` : ""}`, status);
  if (status >= 500) return new ModelError(`The model provider is temporarily unavailable (HTTP ${status}). Try again shortly.`, status);
  return new ModelError(`Model request failed (HTTP ${status}): ${detail}`, status);
}

const hasImages = (messages: ReadonlyArray<ModelMessage>): boolean =>
  messages.some((m) => m.content.some((b) => b.type === "image" || (b.type === "tool_result" && b.content.some((c) => c.type === "image"))));

/**
 * Calls an OpenAI-compatible `/chat/completions` endpoint with streaming and function tools.
 * Tool-result images ride in a user message after the tool messages; if the endpoint rejects images the
 * client retries once without them (leaving a text note in the tool result) and stays in text-only mode.
 */
export class OpenAiModelClient implements ModelClient {
  private imagesAllowed = true;

  constructor(private readonly options: OpenAiClientOptions) {}

  private get endpoint(): string {
    return `${(this.options.baseUrl ?? DEFAULT_OPENAI_BASE_URL).replace(/\/+$/, "")}/chat/completions`;
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    try {
      try {
        return await this.send(request);
      } catch (error) {
        if (error instanceof HttpFailure && error.status >= 400 && error.status < 500 && error.status !== 401 && error.status !== 403 && error.status !== 429
          && this.imagesAllowed && hasImages(request.messages) && IMAGE_ERROR_PATTERN.test(error.detail)) {
          this.imagesAllowed = false;
          return await this.send(request);
        }
        throw error;
      }
    } catch (error) {
      if (request.signal?.aborted || isAbortError(error)) throw new DOMException("The model request was aborted", "AbortError");
      if (error instanceof ModelError) throw error;
      if (error instanceof HttpFailure) throw describeHttpFailure(error);
      const message = error instanceof Error ? error.message : String(error);
      throw new ModelError(`Could not reach the model endpoint: ${redactProviderSecrets(message, this.options.apiKey)}`);
    }
  }

  private async send(request: ModelRequest): Promise<ModelResponse> {
    const { apiKey } = this.options;
    const body = {
      model: request.model,
      messages: toWireMessages(request.system, request.messages, this.imagesAllowed),
      ...(request.tools.length > 0
        ? { tools: request.tools.map((tool) => ({ type: "function", function: { name: tool.name, description: tool.description, parameters: { ...tool.inputSchema, type: "object" } } })) }
        : {}),
      [this.options.maxTokensParam ?? "max_completion_tokens"]: request.maxTokens,
      stream: true,
      stream_options: { include_usage: true },
      ...this.options.extraBody,
    };
    const doFetch = this.options.fetch ?? fetch;
    const attempts = (this.options.maxRetries ?? 2) + 1;
    let lastFailure: unknown;
    for (let attempt = 0; attempt < attempts; attempt++) {
      if (attempt > 0) await sleep((this.options.retryDelayMs ?? 500) * attempt, request.signal);
      if (request.signal?.aborted) throw new DOMException("The model request was aborted", "AbortError");
      try {
        const response = await doFetch(this.endpoint, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
          body: JSON.stringify(body),
          signal: request.signal,
        });
        if (!response.ok) {
          const failure = new HttpFailure(response.status, await errorDetail(response, apiKey));
          if (response.status === 429 || response.status >= 500) {
            lastFailure = failure;
            continue;
          }
          throw failure;
        }
        return await this.read(response, request);
      } catch (error) {
        if (error instanceof HttpFailure || request.signal?.aborted || isAbortError(error) || error instanceof ModelError) throw error;
        lastFailure = error;
      }
    }
    throw lastFailure;
  }

  private async read(response: Response, request: ModelRequest): Promise<ModelResponse> {
    const acc: Accumulator = { text: "", calls: new Map(), finishReason: null, usage: null };
    const contentType = response.headers.get("content-type") ?? "";
    if (response.body && !contentType.includes("application/json")) {
      await readEventStream(response.body, acc, request.onTextDelta);
    } else {
      const chunk = (await response.json()) as WireChunk;
      if (chunk.error) throw new ModelError(`The model reported an error: ${redactProviderSecrets(chunk.error.message ?? "unknown", this.options.apiKey)}`);
      absorb(acc, chunk, request.onTextDelta);
    }
    return { content: toContent(acc), stopReason: toStopReason(acc.finishReason, acc.calls.size > 0), usage: toUsage(acc.usage) };
  }
}
