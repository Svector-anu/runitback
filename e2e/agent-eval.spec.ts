import { expect, test, type Locator, type Page } from "@playwright/test";
import type { MediaAnalysis } from "../src/engine/analysis";
import type { Project } from "../src/engine/model";
import { caseById } from "../evals/cases";
import { POLICIES } from "../evals/policies";
import { truthFromAnalysis, truthFromSpec } from "../evals/fixtures";
import { scoreCase } from "../evals/score";
import type { CaseResult, EvalCase, ResolvedFixture, RunSummary } from "../evals/types";
import { importGenerated } from "./media";

/**
 * The agent eval harness on REAL decoded media. Each case's fixtures are generated as real WebM files in the page,
 * imported through the UI, edited by the real in-app agent loop (dev-only `window.__agentModel` hook) driven by the
 * case's scripted oracle, and scored with the same checks as `pnpm eval` - against ground truth measured from the
 * decoded media by the real analyzer, not only the declaration.
 */

const ENTRY_URL = "/evals/browser-entry.ts";
type Entry = typeof import("../evals/browser-entry");

/** Cases that run on real media; the rest of the suite is covered headlessly. */
const REAL_MEDIA_CASES = ["remove-silences", "trim-to-duration", "reorder-clips", "captions-from-srt", "speed-to-fit", "title-fade", "cut-to-beat"] as const;

async function prepare(page: Page, evalCase: EvalCase): Promise<{ assetIds: Record<string, string> }> {
  await page.goto("/#/projects");
  await page.getByRole("button", { name: "Create your first project" }).click();
  await expect(page).toHaveURL(/#\/editor\//);
  await page.evaluate(async ({ url, specs }) => {
    const entry = (await import(/* @vite-ignore */ url)) as Entry;
    await entry.generateIntoImportQueue(specs);
  }, { url: ENTRY_URL, specs: evalCase.fixtures });
  await importGenerated(page);
  const assets = await page.evaluate(async ({ url, count }) => {
    const entry = (await import(/* @vite-ignore */ url)) as Entry;
    return entry.waitForAssets(count);
  }, { url: ENTRY_URL, count: evalCase.fixtures.length });
  const assetIds = Object.fromEntries(assets.map((a) => [a.name, a.id]));
  for (const spec of evalCase.fixtures) expect(assetIds[spec.name], `${spec.name} was imported`).toBeTruthy();
  await page.evaluate(async ({ url, specs, ids }) => {
    const entry = (await import(/* @vite-ignore */ url)) as Entry;
    await entry.placeFixtures({ specs, assetIds: ids });
  }, { url: ENTRY_URL, specs: evalCase.fixtures, ids: assetIds });
  return { assetIds };
}

const snapshot = (page: Page): Promise<Project> =>
  page.evaluate(async (url) => ((await import(/* @vite-ignore */ url)) as Entry).snapshot(), ENTRY_URL);

async function runAndScore(page: Page, input: { caseId: string; policyId: string }): Promise<{ measured: CaseResult; declared: CaseResult; inApp: { run: RunSummary; toolCalls: string[] }; panel: Locator }> {
  const evalCase = caseById(input.caseId);
  const { assetIds } = await prepare(page, evalCase);

  await page.getByRole("tab", { name: "Agent" }).click();
  const panel = page.getByTestId("agent-panel");
  await expect(panel).toBeVisible();

  const initial = await snapshot(page);
  const inApp = await page.evaluate(async ({ url, id, policyId, brief }) => {
    const entry = (await import(/* @vite-ignore */ url)) as Entry;
    return entry.runPolicyInApp({ caseId: id, policyId, brief });
  }, { url: ENTRY_URL, id: input.caseId, policyId: input.policyId, brief: evalCase.brief });
  const final = await snapshot(page);

  await expect(panel.getByTestId("agent-tool-chip")).toHaveCount(inApp.toolCalls.length);
  const undo = panel.getByRole("button", { name: "Undo agent changes" });
  if (inApp.run.changed) {
    await expect(undo).toBeEnabled();
    await undo.click();
  }
  const afterUndo = await snapshot(page);

  const analyses = await page.evaluate(async (url) => ((await import(/* @vite-ignore */ url)) as Entry).measureAssets(), ENTRY_URL) as Record<string, MediaAnalysis>;
  const toFixtures = (truthOf: (spec: ResolvedFixture["spec"], analysis: MediaAnalysis) => ResolvedFixture["truth"]): ResolvedFixture[] =>
    evalCase.fixtures.map((spec) => {
      const assetId = assetIds[spec.name] as string;
      return { spec, assetId, truth: truthOf(spec, analyses[assetId] as MediaAnalysis) };
    });
  const score = (fixtures: ResolvedFixture[]): CaseResult =>
    scoreCase({ evalCase, policyId: `${input.policyId}@real-media`, toolCalls: inApp.toolCalls, check: { initial, final, afterUndo, fixtures, run: inApp.run } });
  return { measured: score(toFixtures(truthFromAnalysis)), declared: score(toFixtures((spec) => truthFromSpec(spec))), inApp, panel };
}

const failures = (result: CaseResult): string[] => result.outcomes.filter((o) => !o.pass).map((o) => `${o.id}: ${o.detail}`);

for (const caseId of REAL_MEDIA_CASES) {
  test(`oracle solves "${caseId}" on real media through the in-app agent loop`, async ({ page }) => {
    const { measured, declared, inApp, panel } = await runAndScore(page, { caseId, policyId: "oracle" });
    await expect(panel.getByTestId("agent-assistant-text").last()).toBeVisible();
    expect(inApp.run.status, inApp.run.finalText).toBe("done");
    expect(inApp.run.changed).toBe(true);
    expect(failures(measured), "checks scored against ground truth measured from the decoded media").toEqual([]);
    expect(failures(declared), "checks scored against the declared fixture structure").toEqual([]);
  });
}

const REAL_MEDIA_MUTATIONS: Array<{ caseId: string; policyId: string }> = [
  { caseId: "remove-silences", policyId: "lazy" },
  { caseId: "remove-silences", policyId: "no-ripple" },
  { caseId: "cut-to-beat", policyId: "off-beat" },
];

for (const { caseId, policyId } of REAL_MEDIA_MUTATIONS) {
  test(`the "${policyId}" mutation of "${caseId}" is caught on real media`, async ({ page }) => {
    const policy = POLICIES.find((p) => p.caseId === caseId && p.id === policyId);
    expect(policy?.mustFail.length).toBeGreaterThan(0);
    const { measured } = await runAndScore(page, { caseId, policyId });
    const failed = measured.outcomes.filter((o) => !o.pass).map((o) => o.id);
    for (const id of policy?.mustFail ?? []) expect(failed, JSON.stringify(failures(measured))).toContain(id);
    expect(measured.outcomes.filter((o) => o.invariant && !o.pass).map((o) => o.id), "mutations stay well-formed").toEqual([]);
  });
}
