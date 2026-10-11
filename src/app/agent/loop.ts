import {
  PLAN_TOOL_SCHEMAS, PROPOSE_PLAN_DESCRIPTION, PROPOSE_PLAN_TOOL, UPDATE_PLAN_STEP_DESCRIPTION, UPDATE_PLAN_STEP_TOOL,
  callTool, formatPlan, isSingleTargetedEdit, parsePlan, parseStepUpdate, planScopeViolation,
  type AgentToolRegistry, type Plan, type PlanStepStatus, type ToolContext, type ToolResult,
} from "#/engine/agent";
import type { Editor } from "#/engine/editor";
import {
  DEFAULT_AGENT_MODEL, DEFAULT_MAX_RESPONSE_TOKENS, ZERO_USAGE, addUsage, redactSecrets, totalTokens,
  type AssistantBlock, type ImageBlock, type ModelClient, type ModelMessage, type TextBlock, type TokenUsage, type ToolResultBlock,
  type ToolUseBlock, type UserBlock,
} from "./model-client";
import { buildSystemPrompt } from "./system-prompt";

export const DEFAULT_MAX_STEPS = 30;
export const DEFAULT_TOKEN_BUDGET = 1_000_000;
/** Older images are replaced by a text stub when a request is built, so frames do not pile up in the context. */
export const MAX_IMAGES_IN_CONTEXT = 6;
export const MAX_RESULT_DATA_CHARS = 8000;
/** The newest assistant steps of the current request whose tool results are always sent in full. */
export const KEEP_RECENT_STEPS = 6;
/** Older results are stubbed in blocks of this many steps, so the cached request prefix only changes once per block. */
export const COMPACTION_STEP_QUANTUM = 4;
/** A stale tool result shorter than this is cheaper to keep than to stub. */
export const MIN_STUB_CHARS = 600;

export type AgentEvent =
  | { type: "step"; step: number; maxSteps: number }
  | { type: "text_delta"; delta: string }
  | { type: "text"; text: string }
  | { type: "tool_call"; id: string; name: string; args: unknown }
  | { type: "tool_result"; id: string; name: string; ok: boolean; summary: string; detail: string; durationMs: number; planStep?: number }
  | { type: "notice"; text: string }
  | { type: "plan"; plan: Plan; revision: number }
  | { type: "plan_decision"; decision: "approved" | "revise" | "rejected"; feedback?: string }
  | { type: "plan_step"; step: number; status: PlanStepStatus; note: string }
  | { type: "image"; id: string; mediaType: "image/jpeg" | "image/png"; base64: string; caption: string }
  | { type: "usage"; usage: TokenUsage }
  | { type: "done"; status: AgentStatus; text: string }
  | { type: "error"; message: string };

export type AgentStatus = "done" | "aborted" | "error" | "max_steps" | "token_budget" | "busy" | "rejected";

export type PlanDecision = { kind: "approve" } | { kind: "revise"; feedback: string } | { kind: "reject" };

/**
 * Plan-then-execute. Absent = no plan tools and no gate (headless callers, evals). "ask" shows each proposed plan to
 * `decide` and edits wait for its answer; "auto-approve" records the plan and approves it at once (scripted policies).
 */
export type PlanningOptions =
  | { mode: "auto-approve" }
  | { mode: "ask"; decide: (plan: Plan) => Promise<PlanDecision> };

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
  planning?: PlanningOptions;
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

const isGoalMessage = (message: ModelMessage): boolean => message.role === "user" && !message.content.some((b) => b.type === "tool_result");

function stubFor(input: { name: string; block: ToolResultBlock }): ToolResultBlock | null {
  const texts = input.block.content.filter((c): c is TextBlock => c.type === "text");
  const images = input.block.content.length - texts.length;
  const chars = texts.reduce((sum, t) => sum + t.text.length, 0);
  if (images === 0 && chars < MIN_STUB_CHARS) return null;
  const headline = (texts[0]?.text.split("\n")[0] ?? "").slice(0, 160);
  const what = `${input.name}, ${chars} chars${images > 0 ? `, ${images} image(s)` : ""}`;
  const text = `[result omitted: ${what}. Call ${input.name} again if you still need it.${headline ? ` It began: ${headline}` : ""}]`;
  return { ...input.block, content: [{ type: "text", text }] };
}

/**
 * Copies `messages` with the bulky tool results of stale steps replaced by a one-line stub, so a long conversation does
 * not resend every analysis dump and frame on each call. Stale = results from earlier user requests, and results older
 * than the newest `keepRecent` assistant steps of the current request (rounded down to a multiple of the quantum, which
 * keeps the request prefix, and so the prompt cache, unchanged between most steps). Tool_use and tool_result blocks are
 * only edited in content, never added or removed, so pairing stays valid; the latest step's results are never touched.
 */
export function compactHistory(messages: ReadonlyArray<ModelMessage>, options: { keepRecent?: number; quantum?: number } = {}): ModelMessage[] {
  const keepRecent = options.keepRecent ?? KEEP_RECENT_STEPS;
  const quantum = Math.max(1, options.quantum ?? COMPACTION_STEP_QUANTUM);
  let goalIndex = -1;
  messages.forEach((m, i) => { if (isGoalMessage(m)) goalIndex = i; });
  const assistantSteps = messages.flatMap((m, i) => (i > goalIndex && m.role === "assistant" ? [i] : []));
  const staleSteps = Math.floor(Math.max(0, assistantSteps.length - keepRecent) / quantum) * quantum;
  const staleBefore = staleSteps === 0 ? goalIndex : (assistantSteps[staleSteps - 1] as number) + 1;

  const names = new Map<string, string>();
  for (const m of messages) {
    if (m.role === "assistant") for (const b of m.content) if (b.type === "tool_use") names.set(b.id, b.name);
  }
  return messages.map((message, index) => {
    if (message.role !== "user" || index > staleBefore) return message;
    let changed = false;
    const content = message.content.map((block): UserBlock => {
      if (block.type !== "tool_result") return block;
      const stub = stubFor({ name: names.get(block.toolUseId) ?? "the tool", block });
      if (!stub) return block;
      changed = true;
      return stub;
    });
    return changed ? { role: "user", content } : message;
  });
}

function describeFailure(error: unknown): string {
  return redactSecrets(error instanceof Error ? error.message : String(error));
}

interface LoopEnd {
  status: Extract<AgentStatus, "done" | "max_steps" | "token_budget" | "rejected">;
  finalText: string;
}

const textResult = (id: string, text: string, isError = false): ToolResultBlock => ({ type: "tool_result", toolUseId: id, isError, content: [{ type: "text", text }] });

/**
 * The run's undo step. Without planning it spans the whole run. With planning it is opened lazily by the first edit that
 * is allowed to run (after approval, or the one unplanned edit) and committed before any wait for the user, so a wait
 * never holds a transaction open and nothing the user does meanwhile can be rolled back with it.
 */
class TurnLedger {
  private open = false;
  private docAtBegin: unknown = null;
  /** True when a committed transaction of this run changed the document (and was not reverted). */
  changed = false;

  constructor(private readonly editor: Editor, private readonly label: string) {}

  ensure(): void {
    if (this.open) return;
    this.editor.beginTransaction(this.label);
    this.open = true;
    this.docAtBegin = this.editor.getState().doc;
  }

  commit(): void {
    if (!this.open) return;
    this.editor.commitTransaction();
    this.open = false;
    if (this.editor.getState().doc !== this.docAtBegin) this.changed = true;
  }

  rollback(): void {
    if (!this.open) return;
    this.editor.rollbackTransaction();
    this.open = false;
  }
}

/** An edit the user never saw a plan for is allowed once (a single, fully specified edit); anything more needs an approved plan. */
const UNPLANNED_EDIT_LIMIT = 1;

interface PlanGate {
  plan: Plan | null;
  /** A plan was proposed at least once in this run. */
  proposed: boolean;
  approved: boolean;
  /** Element and track ids that existed when the plan was approved; the plan's targets bind only these. */
  approvedIds: ReadonlySet<string>;
  unplannedEdits: number;
  /** Documents around the unplanned edit (its own committed undo step); a later plan reverts it only if nothing changed since. */
  docBeforeUnplanned: unknown;
  docAfterUnplanned: unknown;
  revision: number;
  /** 1-based step currently marked running. */
  running: number | null;
}

/** Undoes the unplanned edit's own undo step, only while the document is exactly what that edit produced. */
function revertUnplanned(editor: Editor, gate: PlanGate): "reverted" | "kept" {
  if (gate.docBeforeUnplanned === gate.docAfterUnplanned || editor.getState().doc !== gate.docAfterUnplanned) return "kept";
  if (editor.undo() && editor.getState().doc === gate.docBeforeUnplanned) return "reverted";
  return "kept";
}

interface EditGate {
  refusal: string | null;
  /** The call may change the document. */
  mutating: boolean;
  /** The call is the one allowed edit without an approved plan. */
  unplanned: boolean;
}

function documentIds(editor: Editor): Set<string> {
  const found = new Set<string>();
  for (const scene of editor.getState().doc.scenes) {
    for (const track of [...scene.tracks.overlay, scene.tracks.main, ...scene.tracks.audio]) {
      found.add(track.id);
      for (const element of track.elements) found.add(element.id);
    }
  }
  return found;
}

function gateEdit(input: { name: string; args: unknown; tools: AgentToolRegistry; gate: PlanGate; editor: Editor }): EditGate {
  const { gate } = input;
  const tool = input.tools.get(input.name);
  if (!tool || tool.readOnly) return { refusal: null, mutating: false, unplanned: false };
  if (gate.approved && gate.plan) {
    const violation = planScopeViolation({ plan: gate.plan, tool, args: input.args, existingIds: gate.approvedIds });
    return violation ? { refusal: violation, mutating: false, unplanned: false } : { refusal: null, mutating: true, unplanned: false };
  }
  if (gate.proposed) return { refusal: "Refused: the plan has not been approved, so nothing may be edited yet. Wait for the user's answer to propose_plan.", mutating: false, unplanned: false };
  if (!isSingleTargetedEdit(tool, input.args)) {
    return {
      refusal: `Refused: "${input.name}" as called touches more than one element, is destructive, or changes the whole project, so it needs an approved plan. Call propose_plan (it changes nothing), then execute after the user approves. Only a single edit of one named element may skip the plan.`,
      mutating: false, unplanned: false,
    };
  }
  if (gate.unplannedEdits >= UNPLANNED_EDIT_LIMIT) {
    return {
      refusal: "Refused: more than one edit needs an approved plan. Call propose_plan (it changes nothing; the edit you already made is undone first if the project is unchanged since, so include it in the plan), then execute after the user approves.",
      mutating: false, unplanned: false,
    };
  }
  gate.docBeforeUnplanned = input.editor.getState().doc;
  gate.unplannedEdits++;
  return { refusal: null, mutating: true, unplanned: true };
}

async function proposePlan(input: {
  call: ToolUseBlock; planning: PlanningOptions; gate: PlanGate; options: RunAgentOptions; turn: TurnLedger; emit: (event: AgentEvent) => void;
}): Promise<{ block: ToolResultBlock; rejected?: true }> {
  const { call, planning, gate, options, turn, emit } = input;
  let revertedNote = "";
  if (gate.unplannedEdits > 0) {
    gate.unplannedEdits = 0;
    if (revertUnplanned(options.editor, gate) === "reverted") {
      turn.changed = false;
      revertedNote = "\nYour earlier edit made without a plan was undone so the project stays untouched until approval; include it in the plan.";
      emit({ type: "notice", text: "The agent's first edit was undone: the project stays unchanged until you approve its plan." });
    } else if (gate.docBeforeUnplanned !== gate.docAfterUnplanned) {
      revertedNote = "\nYour earlier edit made without a plan was kept because the project changed since; plan only the remaining work.";
      emit({ type: "notice", text: "The agent made one edit before showing a plan. It was kept because the project changed since; use Undo agent changes to remove it." });
    }
  }
  turn.commit();
  const parsed = parsePlan(call.input, [...options.tools.keys()]);
  if (!parsed.ok) return { block: textResult(call.id, `${parsed.error}\nHint: ${parsed.hint}`, true) };
  gate.plan = parsed.plan;
  gate.proposed = true;
  gate.approved = false;
  gate.running = null;
  gate.revision++;
  emit({ type: "plan", plan: parsed.plan, revision: gate.revision });
  const docAtProposal = options.editor.getState().doc;
  const withNote = (text: string): string => text + revertedNote;
  const decision: PlanDecision = planning.mode === "auto-approve" ? { kind: "approve" } : await raceAbort(planning.decide(parsed.plan), options.signal);
  throwIfAborted(options.signal);

  if (decision.kind === "reject") {
    emit({ type: "plan_decision", decision: "rejected" });
    return { block: textResult(call.id, "The user rejected the plan. Do not edit anything.", true), rejected: true };
  }
  if (decision.kind === "revise") {
    emit({ type: "plan_decision", decision: "revise", feedback: decision.feedback });
    return {
      block: textResult(call.id, withNote(`The user did not approve yet and asks for changes:\n${decision.feedback}\nNothing was edited. Revise the plan accordingly and call propose_plan again.`)),
    };
  }
  if (options.editor.getState().doc !== docAtProposal) {
    emit({ type: "plan_decision", decision: "revise", feedback: "The project changed while the plan was waiting." });
    return {
      block: textResult(call.id, "The project changed while the plan was waiting for approval, so the plan may be stale. Re-inspect with get_timeline and call propose_plan again."),
    };
  }
  gate.approved = true;
  gate.approvedIds = documentIds(options.editor);
  emit({ type: "plan_decision", decision: "approved" });
  return {
    block: textResult(
      call.id,
      withNote(`The user approved this plan:\n${formatPlan(parsed.plan)}\nExecute it in order. Before each step call update_plan_step with status running; after verifying the step call it with status done and the measured result, or failed with the reason. End with a "Verification:" line of measured facts.`),
    ),
  };
}

function handleStepUpdate(input: { call: ToolUseBlock; gate: PlanGate; emit: (event: AgentEvent) => void }): { block: ToolResultBlock; rejected?: true } {
  const { call, gate, emit } = input;
  if (!gate.approved || !gate.plan) return { block: textResult(call.id, "There is no approved plan. Call propose_plan first.", true) };
  const parsed = parseStepUpdate(call.input, gate.plan.steps.length);
  if (!parsed.ok) return { block: textResult(call.id, `${parsed.error}\nHint: ${parsed.hint}`, true) };
  const { step, status, note } = parsed.update;
  if (status === "running") gate.running = step;
  else if (gate.running === step) gate.running = null;
  emit({ type: "plan_step", step, status, note });
  return { block: textResult(call.id, `Step ${step} marked ${status}.`) };
}

async function drive(input: {
  options: RunAgentOptions; messages: ModelMessage[]; usage: { value: TokenUsage }; steps: { value: number }; turn: TurnLedger;
}): Promise<LoopEnd> {
  const { options, messages } = input;
  const emit = options.onEvent ?? (() => undefined);
  const maxSteps = options.maxSteps ?? DEFAULT_MAX_STEPS;
  const budget = options.tokenBudget ?? DEFAULT_TOKEN_BUDGET;
  const ctx: ToolContext = { editor: options.editor, nowMs: options.nowMs ?? (() => Date.now()) };
  const definitions = [...options.tools.values()].map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }));
  const planning = options.planning;
  if (planning) {
    definitions.push(
      { name: PROPOSE_PLAN_TOOL, description: PROPOSE_PLAN_DESCRIPTION, inputSchema: PLAN_TOOL_SCHEMAS[PROPOSE_PLAN_TOOL] },
      { name: UPDATE_PLAN_STEP_TOOL, description: UPDATE_PLAN_STEP_DESCRIPTION, inputSchema: PLAN_TOOL_SCHEMAS[UPDATE_PLAN_STEP_TOOL] },
    );
  }
  const gate: PlanGate = { plan: null, proposed: false, approved: false, approvedIds: new Set(), unplannedEdits: 0, docBeforeUnplanned: null, docAfterUnplanned: null, revision: 0, running: null };
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
      system: options.systemPrompt ?? buildSystemPrompt({ planning: planning !== undefined }),
      tools: definitions,
      messages: limitImages(compactHistory(messages)),
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
    let rejection: string | null = null;
    for (const call of calls) {
      throwIfAborted(options.signal);
      if (rejection !== null) {
        results.push(textResult(call.id, "Skipped: the user rejected the plan. Nothing was edited.", true));
        continue;
      }
      if (planning && (call.name === PROPOSE_PLAN_TOOL || call.name === UPDATE_PLAN_STEP_TOOL)) {
        const handled = call.name === PROPOSE_PLAN_TOOL
          ? await proposePlan({ call, planning, gate, options, turn: input.turn, emit })
          : handleStepUpdate({ call, gate, emit });
        results.push(handled.block);
        if (handled.rejected) rejection = "Plan rejected. No changes were made.";
        continue;
      }
      const edit: EditGate = planning ? gateEdit({ name: call.name, args: call.input, tools: options.tools, gate, editor: options.editor }) : { refusal: null, mutating: false, unplanned: false };
      const refusal = edit.refusal;
      if (refusal) {
        emit({ type: "tool_call", id: call.id, name: call.name, args: call.input });
        emit({ type: "tool_result", id: call.id, name: call.name, ok: false, summary: refusal, detail: refusal, durationMs: 0 });
        results.push(textResult(call.id, refusal, true));
        continue;
      }
      emit({ type: "tool_call", id: call.id, name: call.name, args: call.input });
      const started = Date.now();
      if (edit.mutating) input.turn.ensure();
      const result = await raceAbort(callTool({ tools: options.tools, name: call.name, args: call.input, ctx }), options.signal);
      if (edit.unplanned) {
        input.turn.commit();
        gate.docAfterUnplanned = options.editor.getState().doc;
      }
      const block = toolResultToBlock({ id: call.id, result });
      results.push(block);
      const detail = block.content.filter((c): c is TextBlock => c.type === "text").map((c) => c.text).join("\n");
      emit({
        type: "tool_result", id: call.id, name: call.name, ok: result.ok, durationMs: Date.now() - started,
        summary: result.ok ? result.summary : result.error, detail,
        ...(gate.approved && gate.running !== null ? { planStep: gate.running } : {}),
      });
      if (result.ok) {
        for (const image of result.images ?? []) emit({ type: "image", id: call.id, mediaType: image.mediaType, base64: image.base64, caption: image.caption ?? "" });
      }
    }
    messages.push({ role: "user", content: results });
    if (rejection !== null) {
      messages.push({ role: "assistant", content: [{ type: "text", text: rejection }] });
      return { status: "rejected", finalText: rejection };
    }
  }
}

/**
 * Runs one user request to completion. Without planning the whole run is one editor transaction; with planning, each
 * stretch of edits after an approval is one (a wait for the user never holds one open). One undo reverts it; abort or failure rolls the document back exactly. Never throws: problems come back as a status.
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
  const messages: ModelMessage[] = [...options.history, { role: "user", content: [{ type: "text", text: options.goal }] }];
  const turn = new TurnLedger(options.editor, options.label ?? "Agent edit");
  if (!options.planning) turn.ensure();
  try {
    const end = await drive({ options, messages, usage, steps, turn });
    turn.commit();
    emit({ type: "done", status: end.status, text: end.finalText });
    return { status: end.status, history: messages, finalText: end.finalText, usage: usage.value, steps: steps.value, changed: turn.changed, docAfter: options.editor.getState().doc };
  } catch (error) {
    turn.rollback();
    const aborted = isAbort(error) || options.signal?.aborted === true;
    const message = aborted ? (turn.changed ? "Stopped. Steps that were already completed are kept; the step in progress was undone." : "Stopped. Changes from this request were undone.") : describeFailure(error);
    emit(aborted ? { type: "done", status: "aborted", text: message } : { type: "error", message });
    return {
      status: aborted ? "aborted" : "error", history: options.history, finalText: message, usage: usage.value, steps: steps.value,
      changed: turn.changed, docAfter: options.editor.getState().doc, ...(aborted ? {} : { error: message }),
    };
  } finally {
    activeEditors.delete(options.editor);
  }
}
