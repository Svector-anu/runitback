import { callTool, runAgentTurn, type AgentToolRegistry, type ToolContext, type ToolResult } from "#/engine/agent";
import type { Editor } from "#/engine/editor";
import {
  DEFAULT_AGENT_MODEL, DEFAULT_MAX_RESPONSE_TOKENS, ZERO_USAGE, addUsage, redactSecrets, totalTokens,
  type AssistantBlock, type ImageBlock, type ModelClient, type ModelMessage, type TextBlock, type TokenUsage, type ToolResultBlock,
  type ToolUseBlock, type UserBlock,
} from "./model-client";
import { AGENT_SYSTEM_PROMPT } from "./system-prompt";

export const DEFAULT_MAX_STEPS = 30;
export const DEFAULT_TOKEN_BUDGET = 1_000_000;
/** Older images are replaced by a text stub when a request is built, so frames do not pile up in the context. */
export const MAX_IMAGES_IN_CONTEXT = 6;
export const MAX_RESULT_DATA_CHARS = 8000;

export type AgentEvent =
  | { type: "step"; step: number; maxSteps: number }
  | { type: "text_delta"; delta: string }
  | { type: "text"; text: string }
  | { type: "tool_call"; id: string; name: string; args: unknown }
  | { type: "tool_result"; id: string; name: string; ok: boolean; summary: string; detail: string; durationMs: number }
  | { type: "image"; id: string; mediaType: "image/jpeg" | "image/png"; base64: string; caption: string }
  | { type: "usage"; usage: TokenUsage }
  | { type: "done"; status: AgentStatus; text: string }
  | { type: "error"; message: string };

export type AgentStatus = "done" | "aborted" | "error" | "max_steps" | "token_budget" | "busy";

export interface RunAgentOptions {
  goal: string;
  /** Conversation so far, as returned by the previous run. */
  history: ModelMessage[];
  model: ModelClient;
  modelName?: string;
  tools: AgentToolRegistry;
  editor: Editor;
  signal?: AbortSignal;
  maxSteps?: number;
  /** Cap on total tokens (input + output + cache) across the run. */
  tokenBudget?: number;
  maxResponseTokens?: number;
  onEvent?: (event: AgentEvent) => void;
  nowMs?: () => number;
  systemPrompt?: string;
  /** Undo-step label shown in history. */
  label?: string;
}

export interface AgentRunResult {
  status: AgentStatus;
  /** Conversation to pass to the next run. Unchanged from the input when the run was rolled back. */
  history: ModelMessage[];
  finalText: string;
  usage: TokenUsage;
  steps: number;
  /** True when this run left a committed change in the document (one undo reverts it). */
  changed: boolean;
  /** The editor document right after the run; undo is only safe while the editor still holds exactly this. */
  docAfter: unknown;
  error?: string;
}

const activeEditors = new WeakSet<Editor>();

const isAbort = (error: unknown): boolean => error instanceof Error && error.name === "AbortError";

function abortError(): DOMException {
  return new DOMException("The agent run was stopped", "AbortError");
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw abortError();
}

/** Resolves with the work, or rejects as soon as the signal aborts (the work is left to finish on its own). */
function raceAbort<T>(work: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return work;
  return new Promise<T>((resolve, reject) => {
    if (signal.aborted) {
      reject(abortError());
      return;
    }
    const onAbort = (): void => reject(abortError());
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(
      (value) => { signal.removeEventListener("abort", onAbort); resolve(value); },
      (error: unknown) => { signal.removeEventListener("abort", onAbort); reject(error); },
    );
  });
}

function stringifyData(data: unknown): string {
  if (data === undefined) return "";
  let text: string;
  try {
    text = JSON.stringify(data);
  } catch {
    return "";
  }
  return text.length > MAX_RESULT_DATA_CHARS ? `${text.slice(0, MAX_RESULT_DATA_CHARS)}... [truncated ${text.length - MAX_RESULT_DATA_CHARS} chars]` : text;
}

/** What a model sees for one tool result: the summary, the structured data, then any images. */
export function toolResultToBlock(input: { id: string; result: ToolResult }): ToolResultBlock {
  const { result } = input;
  if (!result.ok) {
    const text = result.hint ? `${result.error}\nHint: ${result.hint}` : result.error;
    return { type: "tool_result", toolUseId: input.id, isError: true, content: [{ type: "text", text }] };
  }
  const data = stringifyData(result.data);
  const content: Array<TextBlock | ImageBlock> = [{ type: "text", text: data ? `${result.summary}\n${data}` : result.summary }];
  for (const image of result.images ?? []) {
    if (image.caption) content.push({ type: "text", text: image.caption });
    content.push({ type: "image", mediaType: image.mediaType, base64: image.base64 });
  }
  return { type: "tool_result", toolUseId: input.id, isError: false, content };
}

/** Copies `messages`, keeping only the newest `keep` images; older ones become a short text stub. */
export function limitImages(messages: ReadonlyArray<ModelMessage>, keep: number = MAX_IMAGES_IN_CONTEXT): ModelMessage[] {
  let remaining = keep;
  const out: ModelMessage[] = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i] as ModelMessage;
    if (message.role !== "user") {
      out.push(message);
      continue;
    }
    const content: UserBlock[] = [];
    for (let j = message.content.length - 1; j >= 0; j--) {
      const block = message.content[j] as UserBlock;
      if (block.type === "image") {
        if (remaining > 0) { remaining--; content.push(block); } else content.push({ type: "text", text: "[older image omitted to save context]" });
      } else if (block.type === "tool_result") {
        const inner: Array<TextBlock | ImageBlock> = [];
        for (let k = block.content.length - 1; k >= 0; k--) {
          const part = block.content[k] as TextBlock | ImageBlock;
          if (part.type === "image") {
            if (remaining > 0) { remaining--; inner.push(part); } else inner.push({ type: "text", text: "[older image omitted to save context]" });
          } else inner.push(part);
        }
        content.push({ ...block, content: inner.reverse() });
      } else content.push(block);
    }
    out.push({ role: "user", content: content.reverse() });
  }
  return out.reverse();
}

function describeFailure(error: unknown): string {
  return redactSecrets(error instanceof Error ? error.message : String(error));
}

interface LoopEnd {
  status: Extract<AgentStatus, "done" | "max_steps" | "token_budget">;
  finalText: string;
}

async function drive(input: {
  options: RunAgentOptions; messages: ModelMessage[]; usage: { value: TokenUsage }; steps: { value: number };
}): Promise<LoopEnd> {
  const { options, messages } = input;
  const emit = options.onEvent ?? (() => undefined);
  const maxSteps = options.maxSteps ?? DEFAULT_MAX_STEPS;
  const budget = options.tokenBudget ?? DEFAULT_TOKEN_BUDGET;
  const ctx: ToolContext = { editor: options.editor, nowMs: options.nowMs ?? (() => Date.now()) };
  const definitions = [...options.tools.values()].map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }));
  let lastText = "";

  const stop = (status: LoopEnd["status"], reason: string): LoopEnd => {
    const text = lastText ? `${lastText}\n\n${reason}` : reason;
    messages.push({ role: "assistant", content: [{ type: "text", text: reason }] });
    return { status, finalText: text };
  };

  for (;;) {
    throwIfAborted(options.signal);
    if (input.steps.value >= maxSteps) return stop("max_steps", `Stopped after ${maxSteps} steps. Your edits so far are kept; ask me to continue if needed.`);
    if (totalTokens(input.usage.value) >= budget) return stop("token_budget", "Stopped because the token budget for this request was used up. Your edits so far are kept; ask me to continue if needed.");

    input.steps.value++;
    emit({ type: "step", step: input.steps.value, maxSteps });
    const response = await options.model.complete({
      model: options.modelName ?? DEFAULT_AGENT_MODEL,
      system: options.systemPrompt ?? AGENT_SYSTEM_PROMPT,
      tools: definitions,
      messages: limitImages(messages),
      maxTokens: options.maxResponseTokens ?? DEFAULT_MAX_RESPONSE_TOKENS,
      signal: options.signal,
      onTextDelta: (delta) => emit({ type: "text_delta", delta }),
    });
    throwIfAborted(options.signal);
    input.usage.value = addUsage(input.usage.value, response.usage);
    emit({ type: "usage", usage: input.usage.value });

    const content: AssistantBlock[] = response.content.length > 0 ? response.content : [{ type: "text", text: "(no response)" }];
    messages.push({ role: "assistant", content });
    const text = content.filter((b): b is TextBlock => b.type === "text").map((b) => b.text).join("\n").trim();
    if (text) {
      lastText = text;
      emit({ type: "text", text });
    }
    const calls = content.filter((b): b is ToolUseBlock => b.type === "tool_use");
    if (calls.length === 0) {
      if (response.stopReason === "max_tokens") {
        const note = "The response was cut off before finishing. Ask me to continue.";
        return { status: "done", finalText: text ? `${text}\n\n${note}` : note };
      }
      return { status: "done", finalText: text };
    }

    const results: ToolResultBlock[] = [];
    for (const call of calls) {
      throwIfAborted(options.signal);
      emit({ type: "tool_call", id: call.id, name: call.name, args: call.input });
      const started = Date.now();
      const result = await raceAbort(callTool({ tools: options.tools, name: call.name, args: call.input, ctx }), options.signal);
      const block = toolResultToBlock({ id: call.id, result });
      results.push(block);
      const detail = block.content.filter((c): c is TextBlock => c.type === "text").map((c) => c.text).join("\n");
      emit({
        type: "tool_result", id: call.id, name: call.name, ok: result.ok, durationMs: Date.now() - started,
        summary: result.ok ? result.summary : result.error, detail,
      });
      if (result.ok) {
        for (const image of result.images ?? []) emit({ type: "image", id: call.id, mediaType: image.mediaType, base64: image.base64, caption: image.caption ?? "" });
      }
    }
    messages.push({ role: "user", content: results });
  }
}

/**
 * Runs one user request to completion. The whole run is one editor transaction, so a single undo reverts everything
 * the agent did; abort or failure rolls the document back exactly. Never throws: problems come back as a status.
 * Only one run may use an editor at a time, and tool calls inside a run execute strictly one after another.
 */
export async function runAgent(options: RunAgentOptions): Promise<AgentRunResult> {
  const emit = options.onEvent ?? (() => undefined);
  const usage = { value: ZERO_USAGE };
  const steps = { value: 0 };
  const idle: AgentRunResult = { status: "busy", history: options.history, finalText: "", usage: ZERO_USAGE, steps: 0, changed: false, docAfter: options.editor.getState().doc };

  if (activeEditors.has(options.editor)) {
    const message = "The agent is already working on this project. Stop it or wait for it to finish.";
    emit({ type: "error", message });
    return { ...idle, error: message };
  }
  if (!options.editor.hasProject) {
    const message = "Open a project before asking the agent to edit.";
    emit({ type: "error", message });
    return { ...idle, status: "error", error: message };
  }
  activeEditors.add(options.editor);
  const before = options.editor.getState().doc;
  const messages: ModelMessage[] = [...options.history, { role: "user", content: [{ type: "text", text: options.goal }] }];
  try {
    const end = await runAgentTurn(options.editor, options.label ?? "Agent edit", () => drive({ options, messages, usage, steps }));
    emit({ type: "done", status: end.status, text: end.finalText });
    const docAfter = options.editor.getState().doc;
    return { status: end.status, history: messages, finalText: end.finalText, usage: usage.value, steps: steps.value, changed: docAfter !== before, docAfter };
  } catch (error) {
    const aborted = isAbort(error) || options.signal?.aborted === true;
    const message = aborted ? "Stopped. Changes from this request were undone." : describeFailure(error);
    emit(aborted ? { type: "done", status: "aborted", text: message } : { type: "error", message });
    return {
      status: aborted ? "aborted" : "error", history: options.history, finalText: message, usage: usage.value, steps: steps.value,
      changed: false, docAfter: options.editor.getState().doc, ...(aborted ? {} : { error: message }),
    };
  } finally {
    activeEditors.delete(options.editor);
  }
}
