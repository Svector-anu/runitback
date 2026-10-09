import { appendFileSync, mkdirSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
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

async function openProjectWith(page: Page, specs: FixtureSpec[], place: FixtureSpec[]): Promise<void> {
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

async function runBrief(page: Page, bridge: Bridge, brief: string, name: string): Promise<RunOutcome> {
  mkdirSync(ARTIFACTS, { recursive: true });
  await page.getByRole("tab", { name: "Agent" }).click();
  const panel = page.getByTestId("agent-panel");
  await panel.getByLabel("Message to the agent").fill(brief);
  await panel.getByRole("button", { name: "Send" }).click();
  await expect(panel.getByTestId("agent-streaming")).toBeVisible({ timeout: 10_000 });
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
