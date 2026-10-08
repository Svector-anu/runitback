import { INVARIANT_CHECKS, runCheck } from "./checks";
import type { CaseResult, CheckInput, CheckOutcome, EvalCase } from "./types";

/** Runs the case's own checks plus the invariant checks over a finished run. */
export function scoreCase(input: { evalCase: EvalCase; policyId: string; check: CheckInput; toolCalls: string[] }): CaseResult {
  const checks = [...input.evalCase.checks, ...INVARIANT_CHECKS];
  const outcomes: CheckOutcome[] = checks.map((check) => ({ id: check.id, invariant: check.invariant === true, ...runCheck(check, input.check) }));
  const score = outcomes.length === 0 ? 0 : outcomes.reduce((sum, o) => sum + o.score, 0) / outcomes.length;
  return {
    caseId: input.evalCase.id,
    policyId: input.policyId,
    run: input.check.run,
    outcomes,
    score,
    passed: outcomes.every((o) => o.pass),
    toolCalls: input.toolCalls,
  };
}
