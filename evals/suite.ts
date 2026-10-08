import { CASES, RUNNABLE_CASES } from "./cases";
import { runCase } from "./harness";
import { POLICIES, type Policy } from "./policies";
import type { CaseResult, EvalCase } from "./types";

export interface PolicyRun {
  policy: Policy;
  result: CaseResult;
  /** Oracle: every check passed. Mutation: it failed overall and every declared check reported a failure. */
  ok: boolean;
  problems: string[];
}

export function judge(policy: Policy, result: CaseResult): PolicyRun {
  const problems: string[] = [];
  if (policy.kind === "oracle") {
    for (const outcome of result.outcomes) if (!outcome.pass) problems.push(`oracle fails ${outcome.id}: ${outcome.detail}`);
  } else {
    if (result.passed) problems.push("mutation passed every check");
    for (const id of policy.mustFail) {
      const outcome = result.outcomes.find((o) => o.id === id);
      if (!outcome) problems.push(`no check named ${id}`);
      else if (outcome.pass) problems.push(`check ${id} did not catch the mutation (${outcome.detail})`);
    }
  }
  return { policy, result, ok: problems.length === 0, problems };
}

export async function runPolicy(evalCase: EvalCase, policy: Policy): Promise<PolicyRun> {
  const result = await runCase({ evalCase, policyId: `${policy.kind}:${policy.id}`, model: policy.build() });
  return judge(policy, result);
}

/** Every oracle and mutation against its case: the scripted CI gate. */
export async function runScriptedSuite(): Promise<PolicyRun[]> {
  const runs: PolicyRun[] = [];
  for (const evalCase of RUNNABLE_CASES) {
    for (const policy of POLICIES.filter((p) => p.caseId === evalCase.id)) runs.push(await runPolicy(evalCase, policy));
  }
  return runs;
}

export const blockedCases = (): EvalCase[] => CASES.filter((c) => c.blocked !== undefined);
