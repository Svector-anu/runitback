import type { TokenUsage } from "#/app/agent/model-client";
import type { CaseResult } from "./types";

/** USD per million tokens. Estimates for budgeting only: check the provider's current price list before quoting them. */
export interface Pricing {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export const DEFAULT_PRICING: Pricing = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 };

export function estimateCostUsd(usage: TokenUsage, pricing: Pricing = DEFAULT_PRICING): number {
  return (
    (usage.inputTokens * pricing.input + usage.outputTokens * pricing.output + usage.cacheReadTokens * pricing.cacheRead + usage.cacheCreationTokens * pricing.cacheWrite) / 1_000_000
  );
}

export const tokensOf = (usage: TokenUsage): number => usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheCreationTokens;

export interface TrialRecord {
  passed: boolean;
  score: number;
  steps: number;
  tokens: number;
  costUsd: number;
  status: string;
  failedChecks: string[];
  finalText: string;
}

export interface CaseReport {
  caseId: string;
  title: string;
  trials: TrialRecord[];
  passRate: number;
  meanScore: number;
  meanSteps: number;
  meanTokens: number;
  meanCostUsd: number;
}

export interface EvalReport {
  startedAt: string;
  model: string;
  trialsPerCase: number;
  pricing: Pricing;
  cases: CaseReport[];
  overall: { passRate: number; meanScore: number; totalTokens: number; totalCostUsd: number };
}

const mean = (values: ReadonlyArray<number>): number => (values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length);

export function trialOf(result: CaseResult, pricing: Pricing): TrialRecord {
  return {
    passed: result.passed,
    score: result.score,
    steps: result.run.steps,
    tokens: tokensOf(result.run.usage),
    costUsd: estimateCostUsd(result.run.usage, pricing),
    status: result.run.status,
    failedChecks: result.outcomes.filter((o) => !o.pass).map((o) => o.id),
    finalText: result.run.finalText.slice(0, 240),
  };
}

export function buildReport(input: {
  startedAt: string; model: string; pricing: Pricing; results: ReadonlyArray<{ caseId: string; title: string; trials: ReadonlyArray<CaseResult> }>;
}): EvalReport {
  const cases = input.results.map((entry): CaseReport => {
    const trials = entry.trials.map((t) => trialOf(t, input.pricing));
    return {
      caseId: entry.caseId, title: entry.title, trials,
      passRate: mean(trials.map((t) => (t.passed ? 1 : 0))),
      meanScore: mean(trials.map((t) => t.score)),
      meanSteps: mean(trials.map((t) => t.steps)),
      meanTokens: mean(trials.map((t) => t.tokens)),
      meanCostUsd: mean(trials.map((t) => t.costUsd)),
    };
  });
  const allTrials = cases.flatMap((c) => c.trials);
  return {
    startedAt: input.startedAt, model: input.model, trialsPerCase: Math.max(0, ...input.results.map((r) => r.trials.length)), pricing: input.pricing, cases,
    overall: {
      passRate: mean(allTrials.map((t) => (t.passed ? 1 : 0))), meanScore: mean(allTrials.map((t) => t.score)),
      totalTokens: allTrials.reduce((n, t) => n + t.tokens, 0), totalCostUsd: allTrials.reduce((n, t) => n + t.costUsd, 0),
    },
  };
}

const pct = (n: number): string => `${Math.round(n * 100)}%`;

export function renderMarkdown(report: EvalReport): string {
  const rows = report.cases.map((c) =>
    `| ${c.caseId} | ${pct(c.passRate)} | ${c.meanScore.toFixed(2)} | ${c.meanSteps.toFixed(1)} | ${Math.round(c.meanTokens).toLocaleString("en-US")} | $${c.meanCostUsd.toFixed(3)} |`);
  const failures = report.cases.flatMap((c) => c.trials.flatMap((t, i) => (t.passed ? [] : [`- ${c.caseId} trial ${i + 1} (${t.status}): failed ${t.failedChecks.join(", ") || "nothing recorded"}`])));
  return [
    `# Agent eval report ${report.startedAt}`,
    "",
    `Model \`${report.model}\`, ${report.trialsPerCase} trial(s) per case.`,
    `Cost uses estimated prices (USD per million tokens: input ${report.pricing.input}, output ${report.pricing.output}, cache read ${report.pricing.cacheRead}, cache write ${report.pricing.cacheWrite}); treat it as a budget guide.`,
    "",
    "| Case | Pass rate | Mean score | Mean steps | Mean tokens | Mean cost |",
    "| --- | --- | --- | --- | --- | --- |",
    ...rows,
    "",
    `Overall: pass rate ${pct(report.overall.passRate)}, mean score ${report.overall.meanScore.toFixed(2)}, ${report.overall.totalTokens.toLocaleString("en-US")} tokens, about $${report.overall.totalCostUsd.toFixed(2)}.`,
    "",
    "## Failures",
    "",
    ...(failures.length > 0 ? failures : ["None."]),
    "",
  ].join("\n");
}
