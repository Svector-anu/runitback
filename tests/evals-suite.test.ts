import { describe, expect, it } from "vitest";
import { CASES, RUNNABLE_CASES } from "../evals/cases";
import { INVARIANT_CHECKS } from "../evals/checks";
import { POLICIES, oracleFor } from "../evals/policies";
import { blockedCases, runPolicy } from "../evals/suite";

describe("eval suite (scripted CI gate)", () => {
  it("has at least eight runnable cases, each with an oracle, a lazy and an overreach mutation", () => {
    expect(RUNNABLE_CASES.length).toBeGreaterThanOrEqual(8);
    for (const evalCase of RUNNABLE_CASES) {
      const policies = POLICIES.filter((p) => p.caseId === evalCase.id);
      expect(policies.filter((p) => p.kind === "oracle"), evalCase.id).toHaveLength(1);
      expect(policies.map((p) => p.id), evalCase.id).toEqual(expect.arrayContaining(["lazy", "overreach"]));
      expect(evalCase.checks.length, evalCase.id).toBeGreaterThan(0);
      expect(evalCase.brief.length).toBeGreaterThan(5);
      expect(evalCase.budget.maxSteps).toBeGreaterThan(0);
    }
  });

  it("lists blocked cases with a reason instead of faking an oracle", () => {
    expect(blockedCases().map((c) => c.id)).toEqual([]);
    for (const blocked of blockedCases()) {
      expect(blocked.blocked).toMatch(/\S{10}/);
      expect(POLICIES.some((p) => p.caseId === blocked.id)).toBe(false);
    }
    expect(CASES.filter((c) => c.blocked === undefined)).toEqual([...RUNNABLE_CASES]);
  });

  it("declares unique case ids and unique check ids per case", () => {
    expect(new Set(CASES.map((c) => c.id)).size).toBe(CASES.length);
    for (const evalCase of CASES) {
      const ids = [...evalCase.checks, ...INVARIANT_CHECKS].map((c) => c.id);
      expect(new Set(ids).size, evalCase.id).toBe(ids.length);
    }
  });

  for (const evalCase of RUNNABLE_CASES) {
    describe(evalCase.id, () => {
      it("the oracle solves it: every check passes, the run is one undo step", async () => {
        const run = await runPolicy(evalCase, oracleFor(evalCase.id));
        expect(run.problems).toEqual([]);
        expect(run.result.passed).toBe(true);
        expect(run.result.score).toBeGreaterThan(0.95);
        expect(run.result.run.status).toBe("done");
        expect(run.result.run.steps).toBeLessThanOrEqual(evalCase.budget.maxSteps);
      });

      for (const policy of POLICIES.filter((p) => p.caseId === evalCase.id && p.kind === "mutation")) {
        it(`catches the "${policy.id}" mutation (${policy.mustFail.join(", ")})`, async () => {
          const run = await runPolicy(evalCase, policy);
          expect(run.problems).toEqual([]);
          expect(run.result.passed).toBe(false);
          for (const id of policy.mustFail) expect(run.result.outcomes.find((o) => o.id === id)?.pass, id).toBe(false);
          const invariantFailures = run.result.outcomes.filter((o) => o.invariant && !o.pass);
          expect(invariantFailures, "mutations are well-formed edits; only task checks may fail").toEqual([]);
        });
      }
    });
  }

  it("is deterministic: two runs of the same policy give identical outcomes", async () => {
    const evalCase = RUNNABLE_CASES[0];
    if (!evalCase) throw new Error("no cases");
    const first = await runPolicy(evalCase, oracleFor(evalCase.id));
    const second = await runPolicy(evalCase, oracleFor(evalCase.id));
    expect(second.result.outcomes).toEqual(first.result.outcomes);
    expect(second.result.toolCalls).toEqual(first.result.toolCalls);
  });
});
