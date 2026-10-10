import type { JsonSchema } from "./types";
import { didYouMean, validateInput } from "./validate";

/**
 * Plan-then-execute protocol. A plan is data the model proposes and the user approves; it is not a document change.
 * `propose_plan` and `update_plan_step` are loop-level tools (see app/agent/loop.ts), not registry tools.
 */

export const PROPOSE_PLAN_TOOL = "propose_plan";
export const UPDATE_PLAN_STEP_TOOL = "update_plan_step";
export const MAX_PLAN_STEPS = 12;
const MAX_TEXT = 400;

export interface PlanStep {
  /** What this step achieves, in one sentence. */
  intent: string;
  /** Tool names the step expects to use. */
  tools: string[];
  /** Clips, tracks or time ranges it touches, e.g. "clip e12 (0-4.5s)". */
  targets: string[];
  /** What will be measured or looked at afterwards to confirm the step worked. */
  check: string;
}

export interface Plan {
  summary: string;
  steps: PlanStep[];
}

export type PlanStepStatus = "pending" | "running" | "done" | "failed";
export type ReportedStepStatus = Exclude<PlanStepStatus, "pending">;

export interface StepUpdate {
  /** 1-based index into the plan. */
  step: number;
  status: ReportedStepStatus;
  note: string;
}

const PLAN_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    summary: { type: "string", description: "One sentence: what the plan achieves overall." },
    steps: {
      type: "array",
      description: `Ordered steps, 1 to ${MAX_PLAN_STEPS}. Each step is one logical edit plus its check.`,
      items: {
        type: "object",
        properties: {
          intent: { type: "string", description: "What this step does, one sentence." },
          tools: { type: "array", items: { type: "string" }, description: "Names of the tools you expect to call in this step." },
          targets: { type: "array", items: { type: "string" }, description: "Clips (ids), tracks or time ranges this step changes. Empty only for steps that change nothing specific." },
          check: { type: "string", description: "What you will measure or look at afterwards to confirm the step worked." },
        },
        required: ["intent", "tools", "targets", "check"],
      },
    },
  },
  required: ["summary", "steps"],
};

const STEP_UPDATE_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    step: { type: "integer", minimum: 1, description: "1-based step number from the approved plan." },
    status: { type: "string", enum: ["running", "done", "failed"] },
    note: { type: "string", description: "For done: the measured result. For failed: what went wrong and what you will do next." },
  },
  required: ["step", "status"],
};

export const PROPOSE_PLAN_DESCRIPTION =
  "Show the user a plan for an editing request and wait for them to approve, edit or reject it. Read-only: it changes nothing in the project. " +
  "Call it after inspecting the project and before any edit (except a single fully specified edit). If the result says the user wants changes, revise and call it again.";

export const UPDATE_PLAN_STEP_DESCRIPTION =
  "Report progress on an approved plan: status running before you start a step, done (with the measured result in note) after you verified it, or failed (with the reason). " +
  "Read-only bookkeeping; it does not edit the project.";

export const PLAN_TOOL_SCHEMAS = {
  [PROPOSE_PLAN_TOOL]: PLAN_SCHEMA,
  [UPDATE_PLAN_STEP_TOOL]: STEP_UPDATE_SCHEMA,
} as const;

export type PlanParse = { ok: true; plan: Plan } | { ok: false; error: string; hint: string };

const clean = (value: string): string => value.trim().replace(/\s+/g, " ").slice(0, MAX_TEXT);

/** Validates and normalizes a model-written plan. Tool names are checked against `knownTools` when given. */
export function parsePlan(input: unknown, knownTools?: ReadonlyArray<string>): PlanParse {
  const checked = validateInput(PLAN_SCHEMA, input);
  if (!checked.ok) return checked;
  const raw = checked.value as { summary: string; steps: Array<{ intent: string; tools: string[]; targets: string[]; check: string }> };
  if (raw.steps.length === 0) return { ok: false, error: "A plan needs at least one step.", hint: "List the edits you intend to make, in order." };
  if (raw.steps.length > MAX_PLAN_STEPS) {
    return { ok: false, error: `A plan can have at most ${MAX_PLAN_STEPS} steps, got ${raw.steps.length}.`, hint: "Merge related edits into one step." };
  }
  const steps: PlanStep[] = [];
  for (const [i, step] of raw.steps.entries()) {
    const intent = clean(step.intent);
    const check = clean(step.check);
    if (!intent) return { ok: false, error: `Step ${i + 1} has an empty intent.`, hint: "Say what the step does." };
    if (!check) return { ok: false, error: `Step ${i + 1} has an empty check.`, hint: "Say what you will measure or look at to confirm the step." };
    const tools = step.tools.map(clean).filter(Boolean);
    if (knownTools) {
      const unknown = tools.find((t) => !knownTools.includes(t));
      if (unknown) {
        const near = didYouMean(unknown, knownTools);
        return { ok: false, error: `Step ${i + 1} names unknown tool "${unknown}".`, hint: near ? `Did you mean "${near}"?` : `Use tool names from your tool list.` };
      }
    }
    steps.push({ intent, tools, targets: step.targets.map(clean).filter(Boolean), check });
  }
  const summary = clean(raw.summary);
  if (!summary) return { ok: false, error: "The plan summary is empty.", hint: "Add one sentence describing the goal." };
  return { ok: true, plan: { summary, steps } };
}

export type StepUpdateParse = { ok: true; update: StepUpdate } | { ok: false; error: string; hint: string };

export function parseStepUpdate(input: unknown, stepCount: number): StepUpdateParse {
  const checked = validateInput(STEP_UPDATE_SCHEMA, input);
  if (!checked.ok) return checked;
  const raw = checked.value as { step: number; status: ReportedStepStatus; note?: string };
  if (raw.step > stepCount) return { ok: false, error: `The plan has ${stepCount} steps, got step ${raw.step}.`, hint: `Use a step number from 1 to ${stepCount}.` };
  return { ok: true, update: { step: raw.step, status: raw.status, note: clean(raw.note ?? "") } };
}

/** The plan as plain text, for the model's own record of what was approved. */
export function formatPlan(plan: Plan): string {
  const lines = plan.steps.map((s, i) => `${i + 1}. ${s.intent} [tools: ${s.tools.join(", ") || "none"}; targets: ${s.targets.join(", ") || "none"}; check: ${s.check}]`);
  return `${plan.summary}\n${lines.join("\n")}`;
}
