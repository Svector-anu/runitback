import type { Plan } from "./plan";
import type { AgentTool } from "./types";

/**
 * Two limits on what an agent may edit, both enforced by the loop (app/agent/loop.ts):
 * - without an approved plan, only a single targeted edit of one element (`isSingleTargetedEdit`);
 * - after approval, only what the approved plan names (`planScopeViolation`).
 */

export const NOT_IN_PLAN = "not in the approved plan: propose an updated plan";

const asRecord = (args: unknown): Record<string, unknown> =>
  typeof args === "object" && args !== null && !Array.isArray(args) ? (args as Record<string, unknown>) : {};

const hasOwn = (target: object, key: string): boolean => Object.prototype.hasOwnProperty.call(target, key);

const ids = (value: unknown): string[] => (Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : typeof value === "string" ? [value] : []);

/**
 * True when one call edits at most one element and nothing else: not marked destructive, no ripple, no array argument
 * with several entries, and, for tools that take element targets, exactly one named. A tool that can default to "every
 * clip" (split without elementIds) therefore counts as multi-target.
 */
export function isSingleTargetedEdit(tool: AgentTool, args: unknown): boolean {
  if (tool.destructive) return false;
  const input = asRecord(args);
  if (input.ripple === true) return false;
  if (Object.values(input).some((v) => Array.isArray(v) && v.length > 1)) return false;
  const properties = tool.inputSchema.properties ?? {};
  if (hasOwn(properties, "elementIds")) {
    const named = Array.isArray(input.elementIds) ? input.elementIds.length : hasOwn(properties, "elementId") && typeof input.elementId === "string" ? 1 : 0;
    if (named !== 1) return false;
  }
  return true;
}

const RANGE = /(\d+(?:\.\d+)?)\s*(?:-|–|—|to)\s*(\d+(?:\.\d+)?)\s*s\b/g;
const TIME_ARGS = ["at", "time"] as const;
const TIME_TOLERANCE_SECONDS = 0.05;

const tokensOf = (text: string): Set<string> => new Set(text.split(/[^A-Za-z0-9_-]+/).filter(Boolean));

/** Ids of the elements and tracks a call acts on. A track id counts only for tools that require it (not an insert destination). */
function targetIds(tool: AgentTool, input: Record<string, unknown>): string[] {
  const found = [...ids(input.elementId), ...ids(input.elementIds)];
  if (tool.inputSchema.required?.includes("trackId")) found.push(...ids(input.trackId));
  return found;
}

/**
 * Why `args` is outside the approved plan, or null. The tool must be listed in some step. When the plan declares
 * targets: an element or track that already existed at approval must be named in them (ids created afterwards, such as
 * the right half of a split, are free), and a cut time must fall inside a declared range like "0-4.5s". Targets that
 * name no existing id and no range are free text and cannot be enforced.
 */
export function planScopeViolation(input: { plan: Plan; tool: AgentTool; args: unknown; existingIds: ReadonlySet<string> }): string | null {
  const { plan, tool } = input;
  const listed = new Set(plan.steps.flatMap((s) => s.tools));
  if (!listed.has(tool.name)) {
    return `Refused: ${NOT_IN_PLAN}. "${tool.name}" is not listed in any step of the approved plan (tools: ${[...listed].join(", ") || "none"}).`;
  }
  const declared = plan.steps.flatMap((s) => s.targets).join("\n");
  if (!declared) return null;
  const args = asRecord(input.args);

  const named = tokensOf(declared);
  const bindsIds = [...named].some((t) => input.existingIds.has(t));
  if (bindsIds) {
    const outside = targetIds(tool, args).filter((id) => input.existingIds.has(id) && !named.has(id));
    if (outside.length > 0) {
      return `Refused: ${NOT_IN_PLAN}. ${outside.join(", ")} ${outside.length === 1 ? "is" : "are"} not among the plan's targets.`;
    }
  }

  const ranges = [...declared.matchAll(RANGE)].map((m) => [Number(m[1]), Number(m[2])] as const);
  if (ranges.length > 0) {
    for (const key of TIME_ARGS) {
      const value = args[key];
      if (typeof value !== "number") continue;
      if (!ranges.some(([from, to]) => value >= from - TIME_TOLERANCE_SECONDS && value <= to + TIME_TOLERANCE_SECONDS)) {
        return `Refused: ${NOT_IN_PLAN}. ${key} ${value}s is outside the time ranges the plan declares.`;
      }
    }
  }
  return null;
}
