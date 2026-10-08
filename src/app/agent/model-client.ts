import Anthropic from "@anthropic-ai/sdk";
import type { JsonSchema } from "#/engine/agent";

export const AGENT_MODELS = [
  { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5 (default)" },
  { id: "claude-opus-5-5", label: "Claude Opus 5.5 (strongest)" },
  { id: "claude-haiku-5-5", label: "Claude Haiku 5.5 (fastest)" },
] as const;

export const DEFAULT_AGENT_MODEL = "claude-sonnet-5-5";
export const DEFAULT_MAX_RESPONSE_TOKENS = 4096;

export type ImageMediaType = "image/jpeg" | "image/png";

export interface TextBlock {
  type: "text";
  text: string;
}

export interface ImageBlock {
  type: "image";
  mediaType: ImageMediaType;
  base64: string;
}

export interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: unknown;
}

export interface ToolResultBlock {
  type: "tool_result";
  toolUseId: string;
  content: Array<TextBlock | ImageBlock>;
  isError: boolean;
}

export type AssistantBlock = TextBlock | ToolUseBlock;
export type UserBlock = TextBlock | ImageBlock | ToolResultBlock;

export type ModelMessage =
  | { role: "user"; content: UserBlock[] }
  | { role: "assistant"; content: AssistantBlock[] };

export interface ModelToolDefinition {
  name: string;
  description: string;
  inputSchema: JsonSchema;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

export const ZERO_USAGE: TokenUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };

export function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheCreationTokens: a.cacheCreationTokens + b.cacheCreationTokens,
  };
}

export function totalTokens(usage: TokenUsage): number {
  return usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheCreationTokens;
}

export interface ModelRequest {
  model: string;
  system: string;
  tools: ModelToolDefinition[];
  messages: ModelMessage[];
  maxTokens: number;
  signal?: AbortSignal;
  /** Called with each streamed fragment of assistant text so the UI can show progress. */
  onTextDelta?: (delta: string) => void;
}

export type StopReason = "end_turn" | "tool_use" | "max_tokens" | "other";

export interface ModelResponse {
  content: AssistantBlock[];
  stopReason: StopReason;
  usage: TokenUsage;
}

/** One model round trip. Implementations must honour `signal` by rejecting with an AbortError. */
export interface ModelClient {
  complete(request: ModelRequest): Promise<ModelResponse>;
}

export class ModelError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = "ModelError";
  }
}

const KEY_PATTERN = /sk-ant-[A-Za-z0-9_-]+/g;

/** Removes anything that looks like an Anthropic key, plus the exact configured key, from text shown to users or logged. */
export function redactSecrets(text: string, apiKey?: string): string {
  const withoutKey = apiKey && apiKey.length >= 8 ? text.split(apiKey).join("[redacted]") : text;
  return withoutKey.replace(KEY_PATTERN, "[redacted]");
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || error.name === "APIUserAbortError");
}

function describeFailure(error: unknown, apiKey: string): ModelError {
  if (error instanceof Anthropic.APIError) {
    const status = error.status;
    if (status === 401 || status === 403) return new ModelError("Anthropic rejected the API key. Check the key in the Agent panel.", status);
    if (status === 429) return new ModelError("Anthropic rate limit reached. Wait a moment and try again.", status);
    if (status === 529 || (status !== undefined && status >= 500)) return new ModelError("Anthropic is temporarily unavailable. Try again shortly.", status);
    return new ModelError(`Anthropic request failed${status ? ` (${status})` : ""}: ${redactSecrets(error.message, apiKey)}`, status);
  }
  const message = error instanceof Error ? error.message : String(error);
  return new ModelError(`Could not reach Anthropic: ${redactSecrets(message, apiKey)}`);
}

type SdkBlock = Anthropic.Messages.ContentBlockParam;

const EPHEMERAL = { type: "ephemeral" } as const;

function toSdkMessages(messages: ModelMessage[]): Anthropic.Messages.MessageParam[] {
  const converted: Anthropic.Messages.MessageParam[] = messages.map((message) => {
    if (message.role === "assistant") {
      const content: SdkBlock[] = message.content.map((block) =>
        block.type === "text" ? { type: "text", text: block.text } : { type: "tool_use", id: block.id, name: block.name, input: block.input });
      return { role: "assistant", content };
    }
    const content: SdkBlock[] = message.content.map((block): SdkBlock => {
      if (block.type === "text") return { type: "text", text: block.text };
      if (block.type === "image") return { type: "image", source: { type: "base64", media_type: block.mediaType, data: block.base64 } };
      return {
        type: "tool_result",
        tool_use_id: block.toolUseId,
        is_error: block.isError,
        content: block.content.map((inner) =>
          inner.type === "text"
            ? { type: "text" as const, text: inner.text }
            : { type: "image" as const, source: { type: "base64" as const, media_type: inner.mediaType, data: inner.base64 } }),
      };
    });
    return { role: "user", content };
  });
  const last = converted[converted.length - 1];
  if (last && Array.isArray(last.content)) {
    const tail = last.content[last.content.length - 1];
    if (tail && (tail.type === "text" || tail.type === "tool_result")) tail.cache_control = EPHEMERAL;
  }
  return converted;
}

function toStopReason(reason: string | null): StopReason {
  return reason === "end_turn" || reason === "tool_use" || reason === "max_tokens" ? reason : "other";
}

export interface AnthropicClientOptions {
  apiKey: string;
  /** Overrides the SDK's fetch; used by tests so no real network is touched. */
  fetch?: typeof fetch;
}

/**
 * Calls the Anthropic Messages API directly from the browser. The system prompt and tool definitions carry
 * cache breakpoints, and so does the newest message, so each loop step only pays for what is new.
 */
export class AnthropicModelClient implements ModelClient {
  private readonly client: Anthropic;

  constructor(private readonly options: AnthropicClientOptions) {
    this.client = new Anthropic({ apiKey: options.apiKey, dangerouslyAllowBrowser: true, fetch: options.fetch, maxRetries: 2 });
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    const tools: Anthropic.Messages.Tool[] = request.tools.map((tool, index) => ({
      name: tool.name,
      description: tool.description,
      input_schema: { ...tool.inputSchema, type: "object" } as Anthropic.Messages.Tool.InputSchema,
      ...(index === request.tools.length - 1 ? { cache_control: EPHEMERAL } : {}),
    }));
    try {
      const stream = this.client.messages.stream(
        {
          model: request.model,
          max_tokens: request.maxTokens,
          system: [{ type: "text", text: request.system, cache_control: EPHEMERAL }],
          tools,
          messages: toSdkMessages(request.messages),
        },
        { signal: request.signal },
      );
      if (request.onTextDelta) stream.on("text", request.onTextDelta);
      const message = await stream.finalMessage();
      const content: AssistantBlock[] = [];
      for (const block of message.content) {
        if (block.type === "text") content.push({ type: "text", text: block.text });
        else if (block.type === "tool_use") content.push({ type: "tool_use", id: block.id, name: block.name, input: block.input });
      }
      return {
        content,
        stopReason: toStopReason(message.stop_reason),
        usage: {
          inputTokens: message.usage.input_tokens,
          outputTokens: message.usage.output_tokens,
          cacheReadTokens: message.usage.cache_read_input_tokens ?? 0,
          cacheCreationTokens: message.usage.cache_creation_input_tokens ?? 0,
        },
      };
    } catch (error) {
      if (request.signal?.aborted || isAbortError(error)) throw new DOMException("The model request was aborted", "AbortError");
      throw describeFailure(error, this.options.apiKey);
    }
  }
}

/** A scripted assistant turn: a fixed response, or a function that sees the request (for assertions or dynamic ids). */
export type ScriptedTurn = ModelResponse | { content: AssistantBlock[]; usage?: Partial<TokenUsage>; stopReason?: StopReason } | ((request: ModelRequest) => ModelResponse | { content: AssistantBlock[] });

/** Replays a fixed list of assistant turns. For tests and headless evals: no network, fully deterministic. */
export class ScriptedModelClient implements ModelClient {
  readonly requests: ModelRequest[] = [];
  private index = 0;

  constructor(private readonly turns: ReadonlyArray<ScriptedTurn>) {}

  get remaining(): number {
    return this.turns.length - this.index;
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    if (request.signal?.aborted) throw new DOMException("The model request was aborted", "AbortError");
    this.requests.push(request);
    const turn = this.turns[this.index++];
    if (!turn) throw new ModelError("ScriptedModelClient ran out of scripted turns");
    const resolved = typeof turn === "function" ? turn(request) : turn;
    const partial = resolved as { content: AssistantBlock[]; usage?: Partial<TokenUsage>; stopReason?: StopReason };
    const hasToolUse = partial.content.some((b) => b.type === "tool_use");
    for (const block of partial.content) if (block.type === "text") request.onTextDelta?.(block.text);
    return {
      content: partial.content,
      stopReason: partial.stopReason ?? (hasToolUse ? "tool_use" : "end_turn"),
      usage: { ...ZERO_USAGE, ...partial.usage },
    };
  }
}
