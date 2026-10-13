import { createAgentTools, type Plan, type PlanStepStatus } from "#/engine/agent";
import type { Editor } from "#/engine/editor";
import type { MediaRuntime } from "#/platform/media-runtime";
import { AGENT_API_KEY_PREF, AGENT_ASK_BEFORE_EDITING_PREF, AGENT_MODEL_PREF, isBoolean, isString, type PrefsStore } from "#/platform/prefs";
import { runAgent, type AgentEvent, type AgentRunResult, type PlanDecision } from "./loop";
import {
  AGENT_MODELS, AnthropicModelClient, DEFAULT_AGENT_MODEL, ZERO_USAGE, redactSecrets, type ModelClient, type ModelMessage, type TokenUsage,
} from "./model-client";
import { createPlatformTools, sharedAnalysisStore, type PendingExport } from "./platform-tools";
import { createAnalysisProvider, getStyleProfileStore } from "./reference-wiring";
import { createAppTemporalTools } from "./temporal-wiring";
import { createAppTranscriptTools } from "./transcript-wiring";
import { createAppUnderstandTools } from "./understand-wiring";
import { createAppFaceTools } from "./face-wiring";
import { createAppTemplateTools } from "./templates-wiring";
import { createAppBackgroundTools } from "./background-wiring";
import { createAppMotionTools } from "./motion-wiring";
import { createAppAudioTools } from "./audio-wiring";
import { createAppVisualTools } from "./visual-wiring";

export interface PlanStepView {
  status: PlanStepStatus;
  /** The model's note: the measured result when done, the reason when failed. */
  note: string;
  /** Summaries of the tool calls that ran while this step was running. */
  results: Array<{ ok: boolean; summary: string }>;
}

/** awaiting: the user must answer. revising: waiting for the model's revised plan. superseded: replaced by a newer plan. cancelled: the run was stopped before the user answered. */
export type PlanItemStatus = "awaiting" | "approved" | "revising" | "rejected" | "superseded" | "cancelled";

export type ChatItem =
  | { id: number; kind: "user"; text: string }
  | { id: number; kind: "assistant"; text: string }
  | { id: number; kind: "tool"; callId: string; name: string; args: unknown; status: "running" | "ok" | "error"; summary: string; detail: string }
  | { id: number; kind: "image"; callId: string; mediaType: "image/jpeg" | "image/png"; base64: string; caption: string }
  | { id: number; kind: "plan"; plan: Plan; revision: number; status: PlanItemStatus; steps: PlanStepView[]; verification: string; feedback: string }
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
  /** "Ask before editing": show a plan and wait for approval before the agent edits. */
  askBeforeEditing: boolean;
  /** A plan is on screen and the run is paused until the user answers. */
  awaitingPlan: boolean;
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
  /** Bumped when the open project changes; events and results of a run from an earlier generation are dropped. */
  private generation = 0;
  private projectId: string | null = null;
  private pendingDecision: ((decision: PlanDecision) => void) | null = null;

  constructor(private readonly deps: AgentSessionDeps) {
    this.state = {
      items: [], running: false, streaming: "", step: 0, usage: ZERO_USAGE, undoableDoc: null, exportFile: null, awaitingPlan: false,
      askBeforeEditing: deps.prefs.read(AGENT_ASK_BEFORE_EDITING_PREF, true, isBoolean),
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

  private updateLatestPlan(change: (item: Extract<ChatItem, { kind: "plan" }>) => Partial<Extract<ChatItem, { kind: "plan" }>>): void {
    const latest = this.state.items.findLast((item) => item.kind === "plan");
    if (!latest) return;
    this.patch({ items: this.state.items.map((item) => (item.id === latest.id && item.kind === "plan" ? { ...item, ...change(item) } : item)) });
  }

  setApiKey(apiKey: string): void {
    const trimmed = apiKey.trim();
    this.deps.prefs.write(AGENT_API_KEY_PREF, trimmed);
    this.patch({ apiKey: trimmed });
  }

  setAskBeforeEditing(on: boolean): void {
    if (this.state.running) return;
    this.deps.prefs.write(AGENT_ASK_BEFORE_EDITING_PREF, on);
    this.patch({ askBeforeEditing: on });
  }

  approvePlan(): void {
    this.settle({ kind: "approve" });
  }

  /** Sends free-text changes back to the model, which answers with a revised plan. */
  revisePlan(feedback: string): void {
    const text = feedback.trim();
    if (text) this.settle({ kind: "revise", feedback: text });
  }

  rejectPlan(): void {
    this.settle({ kind: "reject" });
  }

  private settle(decision: PlanDecision): void {
    const resolve = this.pendingDecision;
    if (!resolve) return;
    this.pendingDecision = null;
    this.patch({ awaitingPlan: false });
    resolve(decision);
  }

  private askUser(): Promise<PlanDecision> {
    this.patch({ awaitingPlan: true });
    return new Promise((resolve) => {
      this.pendingDecision = resolve;
    });
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
    this.generation++;
    this.clear();
  }

  reset(): void {
    if (this.state.running) return;
    this.clear();
  }

  private clear(): void {
    this.history = [];
    this.pendingDecision = null;
    this.patch({ items: [], running: false, streaming: "", step: 0, usage: ZERO_USAGE, undoableDoc: null, exportFile: null, awaitingPlan: false });
  }

  stop(): void {
    this.pendingDecision = null;
    this.patch({ awaitingPlan: false });
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
    const generation = this.generation;
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
    for (const tool of createAppVisualTools()) tools.set(tool.name, tool);
    for (const tool of createAppFaceTools(provider)) tools.set(tool.name, tool);
    for (const tool of createAppUnderstandTools()) tools.set(tool.name, tool);
    for (const tool of createAppTemplateTools()) tools.set(tool.name, tool);
    for (const tool of createAppBackgroundTools(() => controller.signal)) tools.set(tool.name, tool);
    for (const tool of createAppMotionTools(() => controller.signal)) tools.set(tool.name, tool);
    for (const tool of createAppAudioTools()) tools.set(tool.name, tool);

    const toolItems = new Map<string, number>();
    const onEvent = (event: AgentEvent): void => {
      if (generation === this.generation) this.handle(event, toolItems);
    };
    const result = await runAgent({
      goal: text, history: this.history, model, modelName: this.state.model, tools, editor, signal: controller.signal, onEvent,
      ...(this.state.askBeforeEditing ? { planning: { mode: "ask" as const, decide: () => this.askUser() } } : {}),
    });
    if (generation !== this.generation) return result;
    this.controller = null;
    this.history = result.history;
    this.pendingDecision = null;
    this.patch({ running: false, streaming: "", step: 0, awaitingPlan: false, undoableDoc: result.changed ? result.docAfter : null });
    return result;
  }

  /** At the end of a run: steps still marked running did not finish; the closing "Verification:" line goes on the plan. */
  private finishPlan(status: string, text: string): void {
    const verification = /^[\s*_]*Verification:?[\s*_]*(.+)$/im.exec(text)?.[1]?.trim() ?? "";
    this.updateLatestPlan((plan) => ({
      steps: plan.steps.map((step) => (step.status === "running" ? { ...step, status: "failed" as const, note: step.note || (status === "done" ? "Not confirmed before the agent finished." : "Stopped before this step finished.") } : step)),
      verification: plan.status === "approved" ? redactSecrets(verification) : "",
      ...(plan.status === "awaiting" || plan.status === "revising" ? { status: "cancelled" as const } : {}),
    }));
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
        if (event.planStep !== undefined) {
          const result = { ok: event.ok, summary: redactSecrets(event.summary) };
          this.updateLatestPlan((plan) => ({ steps: withStep(plan.steps, event.planStep as number, (step) => ({ ...step, results: [...step.results, result] })) }));
        }
        return;
      }
      case "notice":
        this.append({ kind: "notice", tone: "info", text: event.text });
        return;
      case "plan":
        this.patch({ items: this.state.items.map((item) => (item.kind === "plan" && item.status !== "rejected" ? { ...item, status: "superseded" as const } : item)) });
        this.append({
          kind: "plan", plan: event.plan, revision: event.revision, status: "awaiting", verification: "", feedback: "",
          steps: event.plan.steps.map(() => ({ status: "pending" as const, note: "", results: [] })),
        });
        return;
      case "plan_decision":
        this.updateLatestPlan(() => ({
          status: event.decision === "approved" ? "approved" : event.decision === "rejected" ? "rejected" : "revising",
          feedback: event.feedback ?? "",
        }));
        return;
      case "plan_step":
        this.updateLatestPlan((plan) => ({
          steps: withStep(plan.steps, event.step, (step) => ({ ...step, status: event.status, note: redactSecrets(event.note) })),
        }));
        return;
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
        this.finishPlan(event.status, event.text);
        if (event.status === "aborted") this.append({ kind: "notice", tone: "info", text: event.text });
        else if (event.status === "max_steps") this.append({ kind: "notice", tone: "info", text: "Stopped at the step limit. Your edits so far are kept." });
        else if (event.status === "token_budget") this.append({ kind: "notice", tone: "info", text: "Stopped at the token budget. Your edits so far are kept." });
        return;
    }
  }
}

function withStep(steps: PlanStepView[], oneBased: number, change: (step: PlanStepView) => PlanStepView): PlanStepView[] {
  return steps.map((step, i) => (i === oneBased - 1 ? change(step) : step));
}

type DistributiveOmit<T, K extends keyof never> = T extends unknown ? Omit<T, K> : never;
