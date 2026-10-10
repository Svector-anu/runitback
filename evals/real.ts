import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { redactProviderSecrets } from "#/app/agent/model-client-openai";
import { MODEL_PROVIDERS, createModelClient, pricingFor, resolveProviderId } from "#/app/agent/model-providers";
import { RUNNABLE_CASES } from "./cases";
import { runCase } from "./harness";
import { DEFAULT_PRICING, buildReport, renderMarkdown, type Pricing } from "./report";
import type { CaseResult } from "./types";

const USAGE = `Real-model evals (periodic report, not a CI gate).

  ANTHROPIC_API_KEY=... [ANTHROPIC_BASE_URL=https://api.surplusintelligence.ai/anthropic] pnpm eval:real [--trials N] [--case ID]... [--model ID]
  OPENAI_API_KEY=...    [OPENAI_BASE_URL=${MODEL_PROVIDERS["openai-compatible"].defaultBaseUrl}] pnpm eval:real --provider openai [--model ID] ...

Model calls only happen when the provider's API key env (ANTHROPIC_API_KEY, or OPENAI_API_KEY with --provider openai) is set AND --real is passed (pnpm eval:real passes it).
Provider: --provider anthropic (default) | openai. Model: --model, else EVAL_MODEL, else the provider default (${MODEL_PROVIDERS.anthropic.defaultModel} / ${MODEL_PROVIDERS["openai-compatible"].defaultModel}). Price overrides (USD per million tokens): EVAL_PRICE_INPUT, EVAL_PRICE_OUTPUT.
Reports are written to evals/reports/<timestamp>.json and .md.`;

const DEFAULT_TRIALS = 3;
const REPORT_DIR = join(dirname(fileURLToPath(import.meta.url)), "reports");

function flagValues(argv: ReadonlyArray<string>, name: string): string[] {
  return argv.flatMap((arg, i) => (arg === `--${name}` && argv[i + 1] ? [argv[i + 1] as string] : []));
}

function pricingFromEnv(env: NodeJS.ProcessEnv, registry?: { input: number; output: number }): Pricing {
  const input = Number(env["EVAL_PRICE_INPUT"]);
  const output = Number(env["EVAL_PRICE_OUTPUT"]);
  return {
    ...DEFAULT_PRICING,
    ...(registry ? { input: registry.input, output: registry.output, cacheRead: registry.input / 10, cacheWrite: registry.input } : {}),
    ...(Number.isFinite(input) && input > 0 ? { input, cacheRead: input / 10, cacheWrite: input * 1.25 } : {}),
    ...(Number.isFinite(output) && output > 0 ? { output } : {}),
  };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const provider = MODEL_PROVIDERS[resolveProviderId(flagValues(argv, "provider")[0] ?? "anthropic")];
  const apiKey = process.env[provider.apiKeyEnv];
  if (!argv.includes("--real")) {
    process.stdout.write(`${USAGE}\n\nNo --real flag: nothing was run and no model was called.\n`);
    return;
  }
  if (!apiKey) {
    process.stderr.write(`${provider.apiKeyEnv} is not set: nothing was run and no model was called.\n`);
    process.exitCode = 1;
    return;
  }
  const model = flagValues(argv, "model")[0] ?? process.env["EVAL_MODEL"] ?? provider.defaultModel;
  const trials = Math.max(1, Number(flagValues(argv, "trials")[0] ?? DEFAULT_TRIALS) || DEFAULT_TRIALS);
  const only = flagValues(argv, "case");
  const cases = RUNNABLE_CASES.filter((c) => only.length === 0 || only.includes(c.id));
  if (cases.length === 0) throw new Error(`No runnable case matches ${only.join(", ")}. Known: ${RUNNABLE_CASES.map((c) => c.id).join(", ")}`);

  const pricing = pricingFromEnv(process.env, pricingFor(provider.id, model));
  const startedAt = new Date().toISOString();
  const baseUrl = process.env[provider.baseUrlEnv];
  const client = createModelClient({ provider: provider.id, apiKey, ...(baseUrl ? { baseUrl } : {}) });
  const results: Array<{ caseId: string; title: string; trials: CaseResult[] }> = [];
  for (const evalCase of cases) {
    const caseTrials: CaseResult[] = [];
    for (let trial = 1; trial <= trials; trial++) {
      const result = await runCase({ evalCase, policyId: `model:${model}`, model: client, modelName: model });
      caseTrials.push(result);
      const failed = result.outcomes.filter((o) => !o.pass).map((o) => o.id);
      process.stdout.write(`${evalCase.id} trial ${trial}/${trials}: ${result.passed ? "pass" : `FAIL (${failed.join(", ")})`} score ${result.score.toFixed(2)} steps ${result.run.steps}\n`);
    }
    results.push({ caseId: evalCase.id, title: evalCase.title, trials: caseTrials });
  }

  const report = buildReport({ startedAt, model, pricing, results });
  mkdirSync(REPORT_DIR, { recursive: true });
  const stamp = startedAt.replace(/[:.]/g, "-");
  writeFileSync(join(REPORT_DIR, `${stamp}.json`), `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(join(REPORT_DIR, `${stamp}.md`), renderMarkdown(report));
  process.stdout.write(`\n${renderMarkdown(report)}\nWrote evals/reports/${stamp}.{json,md}\n`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  const known = [process.env["ANTHROPIC_API_KEY"], process.env["OPENAI_API_KEY"]];
  process.stderr.write(`${known.reduce<string>((text, key) => redactProviderSecrets(text, key), message)}\n`);
  process.exitCode = 1;
});
