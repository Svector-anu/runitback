import { appendFileSync, mkdirSync } from "node:fs";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { AnthropicModelClient, ZERO_USAGE, addUsage, redactSecrets, totalTokens, type ModelRequest, type TokenUsage } from "../src/app/agent/model-client";
import type { Project } from "../src/engine/model";
import { documentKey } from "../evals/checks";
import { estimateCostUsd } from "../evals/report";
import { clipsOf } from "../evals/timeline";
import type { FixtureSpec } from "../evals/types";
import { importGenerated } from "./media";

/**
 * Opt-in QA run: the real in-app agent UI, real generated media and a REAL model. Never runs in CI.
 *   REAL_MODEL=1 ANTHROPIC_API_KEY=... [ANTHROPIC_BASE_URL=...] pnpm exec playwright test e2e/agent-real.spec.ts
 * The key stays in this Node process. The page's `window.__agentModel` (dev-only hook) is a thin proxy that forwards
 * each request to `window.__bridgeComplete`, which is exposed from here and calls the API.
 */

const API_KEY = process.env["ANTHROPIC_API_KEY"] ?? "";
const BASE_URL = process.env["ANTHROPIC_BASE_URL"];
const GATEWAY_MODEL = process.env["REAL_MODEL_ID"] ?? "claude-sonnet-4.5";
const ENABLED = process.env["REAL_MODEL"] === "1" && API_KEY.length > 0;
const SCENARIO_BUDGET_USD = 0.5;
const TOTAL_BUDGET_USD = 1.2;
const MAX_MODEL_CALLS = 40;
const ARTIFACTS = "e2e/.artifacts";
const REPORT = `${ARTIFACTS}/agent-real-report.jsonl`;
const ENTRY_URL = "/evals/browser-entry.ts";
type Entry = typeof import("../evals/browser-entry");

test.skip(!ENABLED, "set REAL_MODEL=1 and ANTHROPIC_API_KEY to run against a real model");
test.describe.configure({ mode: "serial" });

let totalCost = 0;

interface Bridge {
  usage: () => TokenUsage;
  calls: () => number;
  cost: () => number;
}

async function installBridge(page: Page): Promise<Bridge> {
  const client = new AnthropicModelClient({ apiKey: API_KEY, ...(BASE_URL ? { baseUrl: BASE_URL } : {}) });
  let usage = ZERO_USAGE;
  let calls = 0;
  await page.exposeFunction("__bridgeComplete", async (payload: string): Promise<string> => {
    const spent = totalCost + estimateCostUsd(usage);
    if (calls >= MAX_MODEL_CALLS || estimateCostUsd(usage) > SCENARIO_BUDGET_USD || spent > TOTAL_BUDGET_USD) {
      return JSON.stringify({ error: `QA budget guard stopped the run after ${calls} calls` });
    }
    calls++;
    try {
      const request = JSON.parse(payload) as ModelRequest;
      const response = await client.complete({ ...request, model: GATEWAY_MODEL });
      usage = addUsage(usage, response.usage);
      return JSON.stringify(response);
    } catch (error) {
      return JSON.stringify({ error: redactSecrets(error instanceof Error ? error.message : String(error), API_KEY) });
    }
  });
  await page.evaluate(() => {
    const host = globalThis as unknown as {
      __bridgeComplete: (payload: string) => Promise<string>;
      __agentModel?: unknown;
    };
    host.__agentModel = {
      async complete(request: { onTextDelta?: (d: string) => void; signal?: AbortSignal }) {
        const { onTextDelta, signal, ...rest } = request;
        void signal;
        const parsed = JSON.parse(await host.__bridgeComplete(JSON.stringify(rest))) as { error?: string; content?: Array<{ type: string; text?: string }> };
        if (parsed.error) throw new Error(parsed.error);
        for (const block of parsed.content ?? []) if (block.type === "text" && block.text) onTextDelta?.(block.text);
        return parsed;
      },
    };
  });
  return { usage: () => usage, calls: () => calls, cost: () => estimateCostUsd(usage) };
}

const TONE: FixtureSpec = { id: "tone", name: "tone.webm", kind: "video", durationSeconds: 4, audio: { kind: "tone" }, blocks: [{ seconds: 4, rgb: [40, 90, 200] }] };
const GAPS: FixtureSpec = {
  id: "gaps", name: "gaps.webm", kind: "video", durationSeconds: 6,
  audio: { kind: "speech", speech: [{ start: 0, end: 1.5 }, { start: 3.5, end: 6 }] },
  blocks: [{ seconds: 6, rgb: [200, 90, 40] }],
};

const ASK_PREF_KEY = "runitback:agent-ask-before-editing";

/** The original scenarios run with "Ask before editing" off (no approval click); the plan scenario turns it on. */
async function openProjectWith(page: Page, specs: FixtureSpec[], place: FixtureSpec[], askBeforeEditing = false): Promise<void> {
  await page.addInitScript(({ key, on }) => localStorage.setItem(key, String(on)), { key: ASK_PREF_KEY, on: askBeforeEditing });
  await page.goto("/#/projects");
  await page.getByRole("button", { name: "Create your first project" }).click();
  await expect(page).toHaveURL(/#\/editor\//);
  await page.evaluate(async ({ url, list }) => {
    const entry = (await import(/* @vite-ignore */ url)) as Entry;
    await entry.generateIntoImportQueue(list);
  }, { url: ENTRY_URL, list: specs });
  await importGenerated(page);
  const assets = await page.evaluate(async ({ url, count }) => {
    const entry = (await import(/* @vite-ignore */ url)) as Entry;
    return entry.waitForAssets(count);
  }, { url: ENTRY_URL, count: specs.length });
  if (place.length > 0) {
    const assetIds = Object.fromEntries(assets.map((a) => [a.name, a.id]));
    await page.evaluate(async ({ url, list, ids }) => {
      const entry = (await import(/* @vite-ignore */ url)) as Entry;
      await entry.placeFixtures({ specs: list, assetIds: ids });
    }, { url: ENTRY_URL, list: place.map((s) => ({ ...s, placeAt: 0 })), ids: assetIds });
  }
}

const snapshot = (page: Page): Promise<Project> =>
  page.evaluate(async (url) => ((await import(/* @vite-ignore */ url)) as Entry).snapshot(), ENTRY_URL);

interface RunOutcome {
  finalText: string;
  steps: number;
  usage: TokenUsage;
  costUsd: number;
  toolChips: number;
  failedChips: number;
  errors: string[];
}

interface PlanGateHooks {
  /** Runs while the plan is on screen and the run is paused, before Approve is clicked. */
  whileAwaiting(plan: Locator): Promise<void>;
}

async function runBrief(page: Page, bridge: Bridge, brief: string, name: string, gate?: PlanGateHooks): Promise<RunOutcome> {
  mkdirSync(ARTIFACTS, { recursive: true });
  await page.getByRole("tab", { name: "Agent" }).click();
  const panel = page.getByTestId("agent-panel");
  await panel.getByLabel("Message to the agent").fill(brief);
  await panel.getByRole("button", { name: "Send" }).click();
  await expect(panel.getByTestId("agent-streaming")).toBeVisible({ timeout: 10_000 });
  if (gate) {
    const plan = panel.getByTestId("agent-plan").first();
    await expect(plan).toHaveAttribute("data-status", "awaiting", { timeout: 180_000 });
    try {
      await gate.whileAwaiting(plan);
    } catch (error) {
      appendFileSync(REPORT, `${JSON.stringify({ scenario: name, gateFailed: true, calls: bridge.calls(), costUsd: bridge.cost() })}\n`);
      throw error;
    }
    await plan.getByRole("button", { name: "Approve" }).click();
  }
  await expect(panel.getByTestId("agent-streaming")).toHaveCount(0, { timeout: 240_000 });
  await page.screenshot({ path: `${ARTIFACTS}/agent-real-${name}.png` });
  const assistant = panel.getByTestId("agent-assistant-text");
  const count = await assistant.count();
  const finalText = count > 0 ? await assistant.nth(count - 1).innerText() : "";
  const errors = await panel.getByRole("alert").allInnerTexts();
  const chips = panel.getByTestId("agent-tool-chip");
  const outcome: RunOutcome = {
    finalText: redactSecrets(finalText, API_KEY),
    steps: bridge.calls(),
    usage: bridge.usage(),
    costUsd: bridge.cost(),
    toolChips: await chips.count(),
    failedChips: await panel.locator('[data-testid="agent-tool-chip"][data-status="error"]').count(),
    errors: errors.map((e) => redactSecrets(e, API_KEY)),
  };
  totalCost += outcome.costUsd;
  appendFileSync(REPORT, `${JSON.stringify({ scenario: name, ...outcome, tokens: totalTokens(outcome.usage) })}\n`);
  return outcome;
}

test.beforeEach(async ({ page }) => {
  page.on("pageerror", (e) => appendFileSync(REPORT, `${JSON.stringify({ pageerror: redactSecrets(e.message, API_KEY) })}\n`));
});

test("cleans up two clips back to back and reports the final length", async ({ page }) => {
  mkdirSync(ARTIFACTS, { recursive: true });
  await openProjectWith(page, [TONE, GAPS], []);
  const original = await snapshot(page);
  const bridge = await installBridge(page);
  const outcome = await runBrief(page, bridge, "put the clips back to back and cut the dead air, then tell me the final length", "back-to-back");
  expect(outcome.errors, "no error notices").toEqual([]);

  const final = await snapshot(page);
  const clips = clipsOf(final);
  expect(clips.length).toBeGreaterThanOrEqual(2);
  for (const lane of ["main", "overlay", "audio"] as const) {
    const sorted = clips.filter((c) => c.lane === lane).sort((a, b) => a.start - b.start);
    for (let i = 1; i < sorted.length; i++) expect(sorted[i]?.start, `no overlap on ${lane}`).toBeGreaterThanOrEqual((sorted[i - 1]?.end ?? 0) - 1e-3);
  }
  const main = clips.filter((c) => c.lane === "main").sort((a, b) => a.start - b.start);
  expect(main[0]?.start ?? -1).toBeLessThan(0.05);
  for (let i = 1; i < main.length; i++) expect((main[i]?.start ?? 0) - (main[i - 1]?.end ?? 0), `clip ${i} adjacent to previous`).toBeLessThan(0.05);
  const measuredEnd = Math.max(...clips.map((c) => c.end));

  const gapsAsset = final.scenes.length > 0 ? clips.filter((c) => c.name.includes("gaps")) : [];
  const deadAir = gapsAsset.reduce((sum, c) => sum + Math.max(0, Math.min(c.trimStart + c.duration * c.rate, 3.3) - Math.max(c.trimStart, 1.7)), 0);
  appendFileSync(REPORT, `${JSON.stringify({ scenario: "back-to-back", measuredEnd, deadAirSecondsLeft: deadAir, main: main.map((c) => [c.name, c.start, c.end, c.trimStart]) })}\n`);
  expect(deadAir, "the 2s silence in gaps.webm is mostly gone").toBeLessThan(0.5);

  const numbers = [...outcome.finalText.matchAll(/(\d+(?:\.\d+)?)\s*(?:s\b|sec|seconds)/gi)].map((m) => Number(m[1]));
  expect(numbers.some((n) => Math.abs(n - measuredEnd) <= 0.2), `reported ${JSON.stringify(numbers)} vs measured ${measuredEnd.toFixed(2)}s`).toBe(true);

  await page.getByTestId("agent-panel").getByRole("button", { name: "Undo agent changes" }).click();
  expect(documentKey(await snapshot(page))).toBe(documentKey(original));
});

test("adds a fading Hello title for the first 3 seconds", async ({ page }) => {
  await openProjectWith(page, [TONE], [TONE]);
  const bridge = await installBridge(page);
  const outcome = await runBrief(page, bridge, "add a title that says Hello for the first 3 seconds with a fade in", "title");
  expect(outcome.errors).toEqual([]);
  const titles = clipsOf(await snapshot(page)).filter((c) => c.type === "text" && String(c.params["content"] ?? "").toLowerCase().includes("hello"));
  expect(titles).toHaveLength(1);
  const title = titles[0];
  expect(title?.start ?? 1).toBeLessThan(0.05);
  expect(Math.abs((title?.duration ?? 0) - 3)).toBeLessThanOrEqual(0.15);
  expect(Object.keys(title?.animations ?? {}).filter((k) => (title?.animations as Record<string, unknown>)[k]), "an opacity animation exists").toContain("opacity");
});

test("asks a question instead of editing on an ambiguous brief", async ({ page }) => {
  await openProjectWith(page, [TONE, GAPS], [TONE]);
  const before = documentKey(await snapshot(page));
  const bridge = await installBridge(page);
  const outcome = await runBrief(page, bridge, "make it better", "ambiguous");
  expect(outcome.finalText).toContain("?");
  expect(documentKey(await snapshot(page)), "project untouched").toBe(before);
  await expect(page.getByTestId("agent-panel").getByRole("button", { name: "Undo agent changes" })).toBeDisabled();
});

test("shows a plan before any edit, leaves the document alone until Approve, and the result matches the measured facts", async ({ page }) => {
  test.setTimeout(360_000);
  await openProjectWith(page, [TONE, GAPS], [], true);
  const original = await snapshot(page);
  const bridge = await installBridge(page);
  const planFacts: { steps: number; docUnchanged: boolean; clipsWhileAwaiting: number; text: string } = { steps: 0, docUnchanged: false, clipsWhileAwaiting: -1, text: "" };

  const outcome = await runBrief(page, bridge, "put the two clips back to back on the main track starting at 0, then tell me the final length in seconds", "plan-then-execute", {
    async whileAwaiting(plan) {
      const during = await snapshot(page);
      planFacts.steps = await plan.getByTestId("agent-plan-step").count();
      planFacts.docUnchanged = documentKey(during) === documentKey(original);
      planFacts.clipsWhileAwaiting = clipsOf(during).length;
      planFacts.text = redactSecrets(await plan.innerText(), API_KEY);
      await page.waitForTimeout(1500);
      expect(documentKey(await snapshot(page)), "still unchanged after a pause").toBe(documentKey(original));
    },
  });
  appendFileSync(REPORT, `${JSON.stringify({ scenario: "plan-then-execute", planFacts })}\n`);
  expect(outcome.errors, "no error notices").toEqual([]);
  expect(planFacts.steps, "plan has steps").toBeGreaterThan(0);
  expect(planFacts.docUnchanged, "document unchanged while the plan awaits approval").toBe(true);
  expect(planFacts.clipsWhileAwaiting).toBe(0);

  const panel = page.getByTestId("agent-panel");
  const plan = panel.getByTestId("agent-plan").first();
  await expect(plan).toHaveAttribute("data-status", "approved");
  await expect(plan.locator('[data-testid="agent-plan-step"][data-status="failed"]')).toHaveCount(0);

  const final = await snapshot(page);
  const clips = clipsOf(final);
  const main = clips.filter((c) => c.lane === "main").sort((a, b) => a.start - b.start);
  expect(main.length).toBeGreaterThanOrEqual(2);
  expect(main[0]?.start ?? -1).toBeLessThan(0.05);
  for (let i = 1; i < main.length; i++) expect((main[i]?.start ?? 0) - (main[i - 1]?.end ?? 0), `clip ${i} adjacent to previous`).toBeLessThan(0.05);
  const measuredEnd = Math.max(...clips.map((c) => c.end));

  const verification = redactSecrets(await plan.getByTestId("agent-plan-verification").innerText().catch(() => ""), API_KEY);
  appendFileSync(REPORT, `${JSON.stringify({ scenario: "plan-then-execute", measuredEnd, verification })}\n`);
  const claimed = [...(verification || outcome.finalText).matchAll(/(\d+(?:\.\d+)?)\s*(?:s\b|sec|seconds)/gi)].map((m) => Number(m[1]));
  expect(claimed.some((n) => Math.abs(n - measuredEnd) <= 0.2), `reported ${JSON.stringify(claimed)} vs measured ${measuredEnd.toFixed(2)}s`).toBe(true);

  await panel.getByRole("button", { name: "Undo agent changes" }).click();
  expect(documentKey(await snapshot(page))).toBe(documentKey(original));
});
