import { createAgentTools } from "#/engine/agent";
import type { Editor } from "#/engine/editor";
import type { MediaRuntime } from "#/platform/media-runtime";
import { AGENT_API_KEY_PREF, AGENT_MODEL_PREF, isString, type PrefsStore } from "#/platform/prefs";
import { runAgent, type AgentEvent, type AgentRunResult } from "./loop";
import {
  AGENT_MODELS, AnthropicModelClient, DEFAULT_AGENT_MODEL, ZERO_USAGE, redactSecrets, type ModelClient, type ModelMessage, type TokenUsage,
} from "./model-client";
import { createPlatformTools, sharedAnalysisStore, type PendingExport } from "./platform-tools";
import { createAnalysisProvider, getStyleProfileStore } from "./reference-wiring";
import { createAppTemporalTools } from "./temporal-wiring";
import { createAppTranscriptTools } from "./transcript-wiring";

export type ChatItem =
  | { id: number; kind: "user"; text: string }
  | { id: number; kind: "assistant"; text: string }
  | { id: number; kind: "tool"; callId: string; name: string; args: unknown; status: "running" | "ok" | "error"; summary: string; detail: string }
  | { id: number; kind: "image"; callId: string; mediaType: "image/jpeg" | "image/png"; base64: string; caption: string }
  | { id: number; kind: "notice"; tone: "error" | "info"; text: string };

export interface AgentSessionState {
  items: ChatItem[];
  running: boolean;
  /** Assistant text streamed so far in the current step. */
  streaming: string;
  step: number;
  usage: TokenUsage;
  apiKey: string;
  model: string;
  /** The document the last run produced; undo is offered only while the editor still holds exactly this. */
  undoableDoc: unknown;
  exportFile: PendingExport | null;
}

export interface AgentSessionDeps {
  editor: Editor;
  runtime: () => MediaRuntime;
  prefs: PrefsStore;
  currentProjectId: () => string | null;
  createModel?: (apiKey: string) => ModelClient;
  /** Development-only scripted model source; never set in production builds. */
  testModel?: () => ModelClient | undefined;
}

interface TestHookHost {
  __agentModel?: ModelClient;
}

/** A scripted model may be injected for e2e tests, but only in dev/test builds: Vite strips this branch from production. */
export function devTestModel(): ModelClient | undefined {
  if (!import.meta.env.DEV) return undefined;
  return (globalThis as TestHookHost).__agentModel;
}

const validModel = (v: unknown): v is string => isString(v) && AGENT_MODELS.some((m) => m.id === v);

/**
 * Chat state and run control for the in-app agent. Framework-free: the panel renders `getState()` and calls
 * `send`, `stop` and `undoLast`. One conversation per open project.
 */
export class AgentSession {
  private state: AgentSessionState;
  private readonly listeners = new Set<() => void>();
  private history: ModelMessage[] = [];
  private controller: AbortController | null = null;
  private nextId = 1;
  private projectId: string | null = null;
  private streamingItem: number | null = null;

  constructor(private readonly deps: AgentSessionDeps) {
    this.state = {
      items: [], running: false, streaming: "", step: 0, usage: ZERO_USAGE, undoableDoc: null, exportFile: null,
      apiKey: deps.prefs.read(AGENT_API_KEY_PREF, "", isString),
      model: deps.prefs.read(AGENT_MODEL_PREF, DEFAULT_AGENT_MODEL, validModel),
    };
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getState = (): AgentSessionState => this.state;

  private patch(change: Partial<AgentSessionState>): void {
    this.state = { ...this.state, ...change };
    for (const l of this.listeners) l();
  }

  private append(item: DistributiveOmit<ChatItem, "id">): number {
    const id = this.nextId++;
    this.patch({ items: [...this.state.items, { ...item, id } as ChatItem] });
    return id;
  }

  private updateItem(id: number, change: Partial<Extract<ChatItem, { kind: "tool" }>>): void {
    this.patch({ items: this.state.items.map((item) => (item.id === id && item.kind === "tool" ? { ...item, ...change } : item)) });
  }

  setApiKey(apiKey: string): void {
    const trimmed = apiKey.trim();
    this.deps.prefs.write(AGENT_API_KEY_PREF, trimmed);
    this.patch({ apiKey: trimmed });
  }

  setModel(model: string): void {
    if (!validModel(model)) return;
    this.deps.prefs.write(AGENT_MODEL_PREF, model);
    this.patch({ model });
  }

  /** Starts a fresh conversation when the open project changes. A running request is stopped first. */
  bindProject(projectId: string | null): void {
    if (this.projectId === projectId) return;
    this.projectId = projectId;
    this.stop();
    this.reset();
  }

  reset(): void {
    if (this.state.running) return;
    this.history = [];
    this.patch({ items: [], streaming: "", step: 0, usage: ZERO_USAGE, undoableDoc: null, exportFile: null });
  }

  stop(): void {
    this.controller?.abort();
  }

  /** Reverts the last run with one editor undo, but only while nothing else has changed the document since. */
  undoLast(): boolean {
    const { editor } = this.deps;
    if (this.state.running || this.state.undoableDoc === null || editor.getState().doc !== this.state.undoableDoc) return false;
    const undone = editor.undo();
    if (undone) {
      this.patch({ undoableDoc: null });
      this.append({ kind: "notice", tone: "info", text: "Undid the agent's changes from the last request." });
    }
    return undone;
  }

  private resolveModel(): ModelClient | null {
    const injected = (this.deps.testModel ?? devTestModel)();
    if (injected) return injected;
    if (!this.state.apiKey) return null;
    return (this.deps.createModel ?? ((apiKey) => new AnthropicModelClient({ apiKey })))(this.state.apiKey);
  }

  async send(goal: string): Promise<AgentRunResult | null> {
    const text = goal.trim();
    if (!text || this.state.running) return null;
    const model = this.resolveModel();
    if (!model) {
      this.append({ kind: "notice", tone: "error", text: "Add your Anthropic API key above to use the agent." });
      return null;
    }
    const controller = new AbortController();
    this.controller = controller;
    this.append({ kind: "user", text });
    this.patch({ running: true, streaming: "", step: 0, undoableDoc: null });
    const { editor, runtime } = this.deps;
    const provider = createAnalysisProvider({ editor, runtime: () => this.deps.runtime(), analysisStore: sharedAnalysisStore, signal: () => controller.signal });
    const tools = new Map(createAgentTools({ reference: { store: getStyleProfileStore(), provider } }));
    for (const tool of createPlatformTools({
      editor, runtime, analysisStore: sharedAnalysisStore, signal: () => controller.signal,
      onExport: (file) => this.patch({ exportFile: file }),
    })) tools.set(tool.name, tool);
    for (const tool of createAppTranscriptTools()) tools.set(tool.name, tool);
    for (const tool of createAppTemporalTools(provider)) tools.set(tool.name, tool);

    const toolItems = new Map<string, number>();
    const onEvent = (event: AgentEvent): void => this.handle(event, toolItems);
    const result = await runAgent({
      goal: text, history: this.history, model, modelName: this.state.model, tools, editor, signal: controller.signal, onEvent,
    });
    this.controller = null;
    this.history = result.history;
    this.patch({ running: false, streaming: "", step: 0, undoableDoc: result.changed ? result.docAfter : null });
    return result;
  }

  private handle(event: AgentEvent, toolItems: Map<string, number>): void {
    switch (event.type) {
      case "step":
        this.patch({ step: event.step, streaming: "" });
        return;
      case "text_delta":
        this.patch({ streaming: this.state.streaming + event.delta });
        return;
      case "text":
        this.patch({ streaming: "" });
        this.append({ kind: "assistant", text: event.text });
        return;
      case "tool_call":
        toolItems.set(event.id, this.append({ kind: "tool", callId: event.id, name: event.name, args: event.args, status: "running", summary: "", detail: "" }));
        return;
      case "tool_result": {
        const id = toolItems.get(event.id);
        if (id !== undefined) this.updateItem(id, { status: event.ok ? "ok" : "error", summary: redactSecrets(event.summary), detail: redactSecrets(event.detail) });
        return;
      }
      case "image":
        this.append({ kind: "image", callId: event.id, mediaType: event.mediaType, base64: event.base64, caption: event.caption });
        return;
      case "usage":
        this.patch({ usage: event.usage });
        return;
      case "error":
        this.append({ kind: "notice", tone: "error", text: redactSecrets(event.message, this.state.apiKey) });
        return;
      case "done":
        if (event.status === "aborted") this.append({ kind: "notice", tone: "info", text: event.text });
        else if (event.status === "max_steps") this.append({ kind: "notice", tone: "info", text: "Stopped at the step limit. Your edits so far are kept." });
        else if (event.status === "token_budget") this.append({ kind: "notice", tone: "info", text: "Stopped at the token budget. Your edits so far are kept." });
        return;
    }
  }
}

type DistributiveOmit<T, K extends keyof never> = T extends unknown ? Omit<T, K> : never;
