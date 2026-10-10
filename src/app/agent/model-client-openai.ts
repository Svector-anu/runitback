import {
  ModelError,
  redactSecrets,
  type AssistantBlock,
  type ImageBlock,
  type ModelClient,
  type ModelRequest,
  type ModelResponse,
  type ModelToolDefinition,
  type StopReason,
  type TextBlock,
  type ToolResultBlock,
  type ToolUseBlock,
} from "./model-client";

const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";

interface OpenAIFunctionCall {
  name: string;
  arguments: string;
}

interface OpenAIToolCall {
  id: string;
  type: "function";
  function: OpenAIFunctionCall;
}

type OpenAIUserContentPart = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };

type OpenAIWireMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string | OpenAIUserContentPart[] }
  | { role: "assistant"; content: string | null; tool_calls?: OpenAIToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

interface OpenAIToolDefinition {
  type: "function";
  function: { name: string; description: string; parameters: ModelToolDefinition["inputSchema"] };
}

interface OpenAIStreamToolCallDelta {
  index: number;
  id?: string;
  function?: { name?: string; arguments?: string };
}

interface OpenAIStreamChoiceDelta {
  content?: string | null;
  tool_calls?: OpenAIStreamToolCallDelta[];
}

interface OpenAIStreamChunk {
  choices?: Array<{ delta?: OpenAIStreamChoiceDelta; finish_reason?: string | null }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number } | null;
}

function toOpenAIMessages({ system, messages }: { system: string; messages: ModelRequest["messages"] }): OpenAIWireMessage[] {
  const wire: OpenAIWireMessage[] = [{ role: "system", content: system }];
  for (const message of messages) {
    if (message.role === "assistant") {
      const text = message.content.filter((block): block is TextBlock => block.type === "text").map((block) => block.text).join("");
      const toolUses = message.content.filter((block): block is ToolUseBlock => block.type === "tool_use");
      wire.push({
        role: "assistant",
        content: text.length > 0 ? text : null,
        ...(toolUses.length > 0
          ? { tool_calls: toolUses.map((block) => ({ id: block.id, type: "function" as const, function: { name: block.name, arguments: JSON.stringify(block.input) } })) }
          : {}),
      });
      continue;
    }
    const toolResults = message.content.filter((block): block is ToolResultBlock => block.type === "tool_result");
    for (const toolResult of toolResults) {
      const text = toolResult.content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
      wire.push({ role: "tool", tool_call_id: toolResult.toolUseId, content: text });
    }
    const remaining = message.content.filter((block): block is TextBlock | ImageBlock => block.type !== "tool_result");
    if (remaining.length === 0) continue;
    const allText = remaining.every((block) => block.type === "text");
    wire.push({
      role: "user",
      content: allText
        ? remaining.map((block) => (block as TextBlock).text).join("")
        : remaining.map((block): OpenAIUserContentPart =>
            block.type === "text" ? { type: "text", text: block.text } : { type: "image_url", image_url: { url: `data:${block.mediaType};base64,${block.base64}` } }),
    });
  }
  return wire;
}

function toOpenAITools(tools: ModelToolDefinition[]): OpenAIToolDefinition[] {
  return tools.map((tool) => ({ type: "function", function: { name: tool.name, description: tool.description, parameters: { ...tool.inputSchema, type: "object" } } }));
}

function toStopReason(reason: string | null | undefined): StopReason {
  if (reason === "tool_calls") return "tool_use";
  if (reason === "length") return "max_tokens";
  if (reason === "stop") return "end_turn";
  return "other";
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

interface AccumulatedToolCall {
  id: string;
  name: string;
  arguments: string;
}

/** Reads an OpenAI-compatible SSE chat-completion stream, forwarding text deltas as they arrive. */
async function readChatCompletionStream({ body, onTextDelta }: { body: ReadableStream<Uint8Array>; onTextDelta?: (delta: string) => void }): Promise<{
  text: string;
  toolCalls: AccumulatedToolCall[];
  finishReason: string | null;
  usage: { inputTokens: number; outputTokens: number };
}> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const toolCalls = new Map<number, AccumulatedToolCall>();
  let text = "";
  let finishReason: string | null = null;
  let usage = { inputTokens: 0, outputTokens: 0 };
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const payload = line.slice("data: ".length).trim();
      if (payload === "[DONE]") continue;
      const chunk = JSON.parse(payload) as OpenAIStreamChunk;
      if (chunk.usage) usage = { inputTokens: chunk.usage.prompt_tokens ?? 0, outputTokens: chunk.usage.completion_tokens ?? 0 };
      const choice = chunk.choices?.[0];
      if (!choice) continue;
      if (choice.finish_reason) finishReason = choice.finish_reason;
      const delta = choice.delta;
      if (delta?.content) {
        text += delta.content;
        onTextDelta?.(delta.content);
      }
      for (const toolCallDelta of delta?.tool_calls ?? []) {
        const existing = toolCalls.get(toolCallDelta.index);
        if (existing) {
          existing.arguments += toolCallDelta.function?.arguments ?? "";
          continue;
        }
        toolCalls.set(toolCallDelta.index, {
          id: toolCallDelta.id ?? "",
          name: toolCallDelta.function?.name ?? "",
          arguments: toolCallDelta.function?.arguments ?? "",
        });
      }
    }
  }
  return { text, toolCalls: [...toolCalls.entries()].sort(([a], [b]) => a - b).map(([, call]) => call), finishReason, usage };
}

export interface OpenAIClientOptions {
  apiKey: string;
  /** OpenAI-compatible endpoint root (chat/completions is appended), e.g. a gateway. Defaults to api.openai.com/v1. */
  baseUrl?: string;
  /** Overrides fetch; used by tests so no real network is touched. */
  fetch?: typeof fetch;
}

/**
 * Calls an OpenAI-compatible Chat Completions endpoint (the `tools`/`tool_calls` function-calling shape that
 * every OpenAI-compatible gateway implements). Streams text deltas through `onTextDelta`, same as AnthropicModelClient.
 */
export class OpenAIModelClient implements ModelClient {
  constructor(private readonly options: OpenAIClientOptions) {}

  async complete(request: ModelRequest): Promise<ModelResponse> {
    const baseUrl = (this.options.baseUrl ?? DEFAULT_OPENAI_BASE_URL).replace(/\/$/, "");
    const doFetch = this.options.fetch ?? fetch;
    const body: Record<string, unknown> = {
      model: request.model,
      messages: toOpenAIMessages({ system: request.system, messages: request.messages }),
      max_tokens: request.maxTokens,
      stream: true,
      stream_options: { include_usage: true },
      ...(request.tools.length > 0 ? { tools: toOpenAITools(request.tools) } : {}),
    };
    try {
      const response = await doFetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${this.options.apiKey}` },
        body: JSON.stringify(body),
        ...(request.signal ? { signal: request.signal } : {}),
      });
      if (!response.ok) {
        const text = redactSecrets(await response.text(), this.options.apiKey);
        if (response.status === 401 || response.status === 403) {
          throw new ModelError(`The API key was rejected (HTTP ${response.status}): ${text}. Check the key in the Agent panel, and the endpoint if you use a gateway.`, response.status);
        }
        if (response.status === 429) throw new ModelError("Rate limit reached. Wait a moment and try again.", response.status);
        if (response.status >= 500) throw new ModelError("The model provider is temporarily unavailable. Try again shortly.", response.status);
        throw new ModelError(`Request failed (${response.status}): ${text}`, response.status);
      }
      if (!response.body) throw new ModelError("The model provider returned an empty response body.");
      const { text, toolCalls, finishReason, usage } = await readChatCompletionStream({ body: response.body, onTextDelta: request.onTextDelta });
      const content: AssistantBlock[] = [];
      if (text.length > 0) content.push({ type: "text", text });
      for (const toolCall of toolCalls) content.push({ type: "tool_use", id: toolCall.id, name: toolCall.name, input: toolCall.arguments.length > 0 ? JSON.parse(toolCall.arguments) : {} });
      return {
        content,
        stopReason: toStopReason(finishReason),
        usage: { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, cacheReadTokens: 0, cacheCreationTokens: 0 },
      };
    } catch (error) {
      if (error instanceof ModelError) throw error;
      if (request.signal?.aborted || isAbortError(error)) throw new DOMException("The model request was aborted", "AbortError");
      const message = error instanceof Error ? error.message : String(error);
      throw new ModelError(`Could not reach the model provider: ${redactSecrets(message, this.options.apiKey)}`);
    }
  }
}
