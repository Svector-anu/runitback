import { appendFileSync, mkdirSync, statSync } from "node:fs";
import { basename } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { AnthropicModelClient, ZERO_USAGE, addUsage, redactSecrets, totalTokens, type ModelRequest, type TokenUsage } from "../src/app/agent/model-client";
import type { Project } from "../src/engine/model";
import { documentKey } from "../evals/checks";
import { clipsOf, type ClipView } from "../evals/timeline";
import { mediabunnyModuleUrl } from "./media";

/**
 * N7: the smallest complete loop on REAL footage with REAL models, opt-in and never run in CI.
 *   REAL_FOOTAGE=1 ANTHROPIC_API_KEY=... [ANTHROPIC_BASE_URL=...] FOOTAGE_PROMO=/path/promo.mp4 FOOTAGE_SHORT=/path/short.mp4 \
 *   [FOOTAGE_FACE=/path/face.mp4] pnpm exec playwright test e2e/real-footage.spec.ts
 * Whisper, CLIP and MediaPipe run for real (the test confirms the consent dialog like a user; models come from Hugging Face).
 * The API key stays in this Node process behind `page.exposeFunction`; it is never put in the page, a trace or a screenshot.
 * Footage is read from disk and never uploaded or committed. Objective checks read the timeline and the exported file, not the agent's claims.
 * `REAL_SCENARIOS=transcript,pace` runs only the named scenarios (vertical-face, transcript, visual, pace); import, Understand and export always run.
 * Defaults for the visual truth ranges describe the 83 s product promo this was written against; override with
 * `FOOTAGE_PAYMENT_RANGE=26,30` and `FOOTAGE_CONFETTI_RANGE=66,70` (source seconds a human checked) for other footage.
 */

const API_KEY = process.env["ANTHROPIC_API_KEY"] ?? "";
const BASE_URL = process.env["ANTHROPIC_BASE_URL"];
const MODEL_ID = process.env["REAL_MODEL_ID"] ?? "claude-haiku-4.5";
const PRICING = { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 };
const TOTAL_BUDGET_USD = Number(process.env["REAL_BUDGET_USD"] ?? "0.5");
const SCENARIO_BUDGET_USD = Number(process.env["REAL_SCENARIO_BUDGET_USD"] ?? TOTAL_BUDGET_USD / 2);
const MAX_CALLS_PER_SCENARIO = 40;

const PROMO = process.env["FOOTAGE_PROMO"];
const SHORT = process.env["FOOTAGE_SHORT"];
const FACE = process.env["FOOTAGE_FACE"];
const range = (name: string, fallback: [number, number]): [number, number] => {
  const raw = process.env[name]?.split(",").map(Number);
  return raw && raw.length === 2 && raw.every(Number.isFinite) ? [raw[0] as number, raw[1] as number] : fallback;
};
const PAYMENT = range("FOOTAGE_PAYMENT_RANGE", [26, 30]);
const CONFETTI = range("FOOTAGE_CONFETTI_RANGE", [66, 70]);

const ONLY = process.env["REAL_SCENARIOS"]?.split(",").map((x) => x.trim()) ?? null;
const wanted = (name: string): boolean => ONLY === null || ONLY.includes(name);
const ENABLED = process.env["REAL_FOOTAGE"] === "1" && API_KEY.length > 0 && !!PROMO && !!SHORT;
const ARTIFACTS = "e2e/.artifacts";
const REPORT = `${ARTIFACTS}/real-footage-report.jsonl`;
const ENTRY_URL = "/evals/browser-entry.ts";
const ASK_PREF_KEY = "runitback:agent-ask-before-editing";
type Entry = typeof import("../evals/browser-entry");

test.skip(!ENABLED, "set REAL_FOOTAGE=1, ANTHROPIC_API_KEY and FOOTAGE_PROMO / FOOTAGE_SHORT to run the real-footage loop");
test.describe.configure({ mode: "serial" });
test.setTimeout(3_600_000);

const files: Record<string, string> = {};
if (PROMO) files["promo.mp4"] = PROMO;
if (SHORT) files["short.mp4"] = SHORT;
if (FACE) files["face.mp4"] = FACE;

const costOf = (u: TokenUsage): number =>
  (u.inputTokens * PRICING.input + u.outputTokens * PRICING.output + u.cacheReadTokens * PRICING.cacheRead + u.cacheCreationTokens * PRICING.cacheWrite) / 1_000_000;

const log = (record: Record<string, unknown>): void => {
  mkdirSync(ARTIFACTS, { recursive: true });
  appendFileSync(REPORT, `${redactSecrets(JSON.stringify(record), API_KEY)}\n`);
};

let page: Page;
let spent = 0;
let modelBlocked: string | null = null;
const state: { promoId: string; faceId: string; shortId: string; transcriptWords: Array<{ text: string; startSeconds: number; endSeconds: number }> } = {
  promoId: "", faceId: "", shortId: "", transcriptWords: [],
};

interface Bridge { usage: () => TokenUsage; calls: () => number; cost: () => number }

/** One bridge per page: the Node side holds the key and counts usage per scenario (`reset`). */
let bridgeUsage = ZERO_USAGE;
let bridgeCalls = 0;
let bridgeBase = 0;
const bridge: Bridge = { usage: () => bridgeUsage, calls: () => bridgeCalls, cost: () => costOf(bridgeUsage) };

async function installBridge(): Promise<void> {
  const client = new AnthropicModelClient({ apiKey: API_KEY, ...(BASE_URL ? { baseUrl: BASE_URL } : {}) });
  await page.exposeFunction("__bridgeComplete", async (payload: string): Promise<string> => {
    if (modelBlocked) return JSON.stringify({ error: `model blocked: ${modelBlocked}` });
    if (bridgeCalls >= MAX_CALLS_PER_SCENARIO || costOf(bridgeUsage) > SCENARIO_BUDGET_USD || spent + costOf(bridgeUsage) - bridgeBase > TOTAL_BUDGET_USD) {
      return JSON.stringify({ error: `budget guard stopped the run after ${bridgeCalls} calls` });
    }
    bridgeCalls++;
    try {
      const response = await client.complete({ ...(JSON.parse(payload) as ModelRequest), model: MODEL_ID });
      bridgeUsage = addUsage(bridgeUsage, response.usage);
      return JSON.stringify(response);
    } catch (error) {
      const status = (error as { status?: number }).status;
      const message = redactSecrets(error instanceof Error ? error.message : String(error), API_KEY);
      if (status !== undefined && status >= 400 && status < 500) modelBlocked = `HTTP ${status}: ${message.slice(0, 300)}`;
      return JSON.stringify({ error: message });
    }
  });
  await page.evaluate(() => {
    const host = globalThis as unknown as { __bridgeComplete: (payload: string) => Promise<string>; __agentModel?: unknown };
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
}

const snapshot = (): Promise<Project> => page.evaluate(async (url) => ((await import(/* @vite-ignore */ url)) as Entry).snapshot(), ENTRY_URL);
const edit = (op: "undo" | "redo"): Promise<boolean> =>
  page.evaluate(async (which) => {
    const { getServices } = (await import(/* @vite-ignore */ "/src/app/".concat("services.ts"))) as typeof import("../src/app/services");
    return which === "undo" ? getServices().editor.undo() : getServices().editor.redo();
  }, op);

interface Kept { name: string; assetId: string; from: number; to: number; start: number; end: number }
function keptRanges(project: Project): Kept[] {
  return clipsOf(project)
    .filter((c): c is ClipView & { mediaId: string } => c.type === "video" && c.mediaId !== undefined)
    .map((c) => ({ name: c.name, assetId: c.mediaId, from: c.trimStart, to: c.trimStart + c.duration * c.rate, start: c.start, end: c.end }))
    .sort((a, b) => a.start - b.start);
}
const timelineEnd = (project: Project): number => Math.max(0, ...clipsOf(project).map((c) => c.end));
const overlapFree = (project: Project): boolean => {
  const byTrack = new Map<string, ClipView[]>();
  for (const c of clipsOf(project)) byTrack.set(c.trackId, [...(byTrack.get(c.trackId) ?? []), c]);
  return [...byTrack.values()].every((list) => {
    const sorted = [...list].sort((a, b) => a.start - b.start);
    return sorted.every((c, i) => i === 0 || c.start >= (sorted[i - 1]?.end ?? 0) - 1e-3);
  });
};
const covered = (kept: Kept[], assetId: string, from: number, to: number): number => {
  const spans = kept.filter((k) => k.assetId === assetId).map((k) => [Math.max(k.from, from), Math.min(k.to, to)] as const).filter(([a, b]) => b > a).sort((a, b) => a[0] - b[0]);
  let total = 0;
  let cursor = from;
  for (const [a, b] of spans) {
    const lo = Math.max(a, cursor);
    if (b > lo) { total += b - lo; cursor = b; }
  }
  return total;
};

interface ScenarioResult {
  name: string;
  brief: string;
  ran: boolean;
  planShown: boolean;
  planSteps: number;
  planText: string;
  docUnchangedWhileAwaiting: boolean | null;
  planStatuses: string[];
  tools: string[];
  failedTools: number;
  steps: number;
  tokens: number;
  costUsd: number;
  wallSeconds: number;
  finalText: string;
  verification: string;
  errors: string[];
  before: Project | null;
  after: Project | null;
  undoRestores: boolean | null;
  redoReapplies: boolean | null;
}

async function runScenario(name: string, brief: string): Promise<ScenarioResult> {
  const result: ScenarioResult = {
    name, brief, ran: false, planShown: false, planSteps: 0, planText: "", docUnchangedWhileAwaiting: null, planStatuses: [], tools: [], failedTools: 0,
    steps: 0, tokens: 0, costUsd: 0, wallSeconds: 0, finalText: "", verification: "", errors: [], before: null, after: null, undoRestores: null, redoReapplies: null,
  };
  if (modelBlocked) {
    result.errors.push(`not run: ${modelBlocked}`);
    return result;
  }
  bridgeUsage = ZERO_USAGE;
  bridgeCalls = 0;
  bridgeBase = 0;
  await page.evaluate(async () => {
    const { getAgentSession } = (await import(/* @vite-ignore */ "/src/app/agent/".concat("instance.ts"))) as typeof import("../src/app/agent/instance");
    getAgentSession().reset();
  });
  const before = await snapshot();
  result.before = before;
  await page.getByRole("tab", { name: "Agent" }).click();
  const panel = page.getByTestId("agent-panel");
  await panel.getByLabel("Message to the agent").fill(brief);
  const started = Date.now();
  await panel.getByRole("button", { name: "Send" }).click();
  result.ran = true;

  const sessionState = (): Promise<{ running: boolean; awaitingPlan: boolean }> =>
    page.evaluate(async () => {
      const { getAgentSession } = (await import(/* @vite-ignore */ "/src/app/".concat("agent/instance.ts"))) as typeof import("../src/app/agent/instance");
      const s = getAgentSession().getState();
      return { running: s.running, awaitingPlan: s.awaitingPlan };
    });

  const deadline = Date.now() + 15 * 60_000;
  await page.waitForTimeout(1500);
  while (Date.now() < deadline) {
    const s = await sessionState();
    if (s.awaitingPlan) {
      const plan = panel.getByTestId("agent-plan").last();
      await expect(plan).toHaveAttribute("data-status", "awaiting", { timeout: 10_000 });
      result.planShown = true;
      result.planSteps = await plan.getByTestId("agent-plan-step").count();
      result.planText = redactSecrets(await plan.innerText(), API_KEY);
      const during = await snapshot();
      result.docUnchangedWhileAwaiting = documentKey(during) === documentKey(before);
      await page.screenshot({ path: `${ARTIFACTS}/real-${name}-plan.png` });
      await plan.getByRole("button", { name: "Approve" }).click();
      await page.waitForTimeout(500);
      continue;
    }
    if (!s.running) break;
    await page.waitForTimeout(700);
  }
  result.wallSeconds = Math.round((Date.now() - started) / 100) / 10;
  await page.screenshot({ path: `${ARTIFACTS}/real-${name}-done.png` });

  const assistant = panel.getByTestId("agent-assistant-text");
  const count = await assistant.count();
  result.finalText = redactSecrets(count > 0 ? await assistant.nth(count - 1).innerText({ timeout: 5000 }) : "", API_KEY);
  result.verification = redactSecrets(await panel.getByTestId("agent-plan-verification").last().innerText({ timeout: 2000 }).catch(() => ""), API_KEY);
  result.errors.push(...(await panel.getByRole("alert").allInnerTexts()).map((e) => redactSecrets(e, API_KEY)));
  result.tools = await panel.getByTestId("agent-tool-chip").evaluateAll((els) => els.map((e) => e.getAttribute("data-tool") ?? ""));
  result.failedTools = await panel.locator('[data-testid="agent-tool-chip"][data-status="error"]').count();
  result.planStatuses = await panel.getByTestId("agent-plan-step").evaluateAll((els) => els.map((e) => e.getAttribute("data-status") ?? ""));
  result.steps = bridge.calls();
  result.tokens = totalTokens(bridge.usage());
  result.costUsd = Math.round(bridge.cost() * 10_000) / 10_000;
  spent += bridge.cost();
  result.after = await snapshot();

  const undo = panel.getByRole("button", { name: "Undo agent changes" });
  if (await undo.isEnabled({ timeout: 5000 })) {
    await undo.click();
    result.undoRestores = documentKey(await snapshot()) === documentKey(before);
    result.redoReapplies = (await edit("redo")) && documentKey(await snapshot()) === documentKey(result.after);
  }
  return result;
}

function record(result: ScenarioResult, checks: Record<string, unknown>, pass: boolean): void {
  const { before, after, ...rest } = result;
  void before;
  log({ ...rest, checks, pass, kept: after ? keptRanges(after) : [], timelineEnd: after ? timelineEnd(after) : null });
  console.log(`[${result.name}] ${pass ? "PASS" : "FAIL"} steps=${result.steps} tokens=${result.tokens} cost=$${result.costUsd} wall=${result.wallSeconds}s tools=${result.tools.join(",")} checks=${JSON.stringify(checks)}`);
}

async function addToTimeline(name: string): Promise<void> {
  await page.getByRole("tab", { name: "Media", exact: true }).click({ timeout: 2000 }).catch(() => undefined);
  await page.getByRole("button", { name: `Add ${name} to timeline` }).click({ force: true });
}

test.beforeAll(async ({ browser }) => {
  mkdirSync(ARTIFACTS, { recursive: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
  page = await context.newPage();
  page.on("pageerror", (e) => log({ pageerror: redactSecrets(e.message, API_KEY) }));
  await page.addInitScript((key) => localStorage.setItem(key, "true"), ASK_PREF_KEY);
  await page.route("**/__real/*", (route) => {
    const key = new URL(route.request().url()).pathname.split("/").pop() ?? "";
    const path = key === "export.mp4" ? exportPath : files[key];
    return path ? route.fulfill({ path, contentType: "video/mp4" }) : route.abort();
  });
});
let exportPath = "";

test("import real footage and Understand it with the real Whisper, CLIP and MediaPipe models", async () => {
  await page.goto("/#/projects");
  await page.getByRole("button", { name: "Create your first project" }).click();
  await expect(page).toHaveURL(/#\/editor\//);
  await installBridge();

  const imported = Date.now();
  await page.locator('input[aria-label="Import media files"]').setInputFiles(Object.values(files));
  await expect(page.locator("[data-asset-id]")).toHaveCount(Object.keys(files).length, { timeout: 120_000 });
  const importSeconds = (Date.now() - imported) / 1000;
  const assets = await page.evaluate(async () => {
    const { getServices } = (await import(/* @vite-ignore */ "/src/app/".concat("services.ts"))) as typeof import("../src/app/services");
    return getServices().editor.getState().doc.assets.map((a) => ({ id: a.id, name: a.name, fps: a.fps, hasAudio: a.hasAudio, durationTicks: a.duration, width: a.width, height: a.height }));
  });
  for (const a of assets) {
    if (a.name === basename(PROMO ?? "")) state.promoId = a.id;
    if (a.name === basename(SHORT ?? "")) state.shortId = a.id;
    if (a.name === basename(FACE ?? "")) state.faceId = a.id;
  }
  log({ stage: "import", importSeconds, assets });
  expect(state.promoId, "promo asset imported under its own file name").not.toBe("");

  await addToTimeline(basename(PROMO ?? ""));
  await expect(page.locator("[data-clip-id]")).toHaveCount(1);

  const started = Date.now();
  await page.getByRole("button", { name: "Understand all new media" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("whisper", { timeout: 20_000 });
  await expect(dialog).toContainText("clip-vit-base-patch32");
  log({ stage: "consent-dialog", text: (await dialog.innerText()).slice(0, 500) });
  await dialog.getByRole("button", { name: "Download and understand" }).click();

  const finishedAt: Record<string, number> = {};
  const tiles = page.locator("[data-asset-id]");
  const total = await tiles.count();
  const timeline: Array<{ t: number; states: string[] }> = [];
  const deadline = Date.now() + 25 * 60_000;
  while (Date.now() < deadline) {
    const states = await tiles.evaluateAll((els) => els.map((e) => `${e.getAttribute("aria-label")}|${e.querySelector(".media-item__status")?.getAttribute("data-state") ?? "none"}|${e.querySelector(".media-item__status")?.textContent ?? ""}|${e.querySelector(".media-item__status")?.getAttribute("title") ?? ""}`));
    const elapsed = Math.round((Date.now() - started) / 1000);
    if (timeline.length === 0 || elapsed - (timeline[timeline.length - 1]?.t ?? 0) >= 10) timeline.push({ t: elapsed, states });
    for (const s of states) {
      const [label = "", st = ""] = s.split("|");
      if ((st === "understood" || st === "partial") && !(label in finishedAt)) finishedAt[label] = elapsed;
    }
    if (Object.keys(finishedAt).length >= total) break;
    await page.waitForTimeout(1000);
  }
  const finalStates = timeline[timeline.length - 1]?.states ?? [];
  const understandSeconds = Math.round((Date.now() - started) / 1000);

  const stored = await page.evaluate(async () => {
    const { getServices } = (await import(/* @vite-ignore */ "/src/app/".concat("services.ts"))) as typeof import("../src/app/services");
    const { getUnderstandService } = (await import(/* @vite-ignore */ "/src/app/".concat("understand-stages.ts"))) as typeof import("../src/app/understand-stages");
    const { getTranscribeService } = (await import(/* @vite-ignore */ "/src/app/".concat("transcribe-service.ts"))) as typeof import("../src/app/transcribe-service");
    const out: Array<{ name: string; id: string; stored: unknown; status: string; words: number }> = [];
    for (const asset of getServices().editor.getState().doc.assets) {
      const transcript = await getTranscribeService().store.get(asset.id);
      out.push({ name: asset.name, id: asset.id, stored: await getUnderstandService().stored(asset), status: (await getUnderstandService().statusOf(asset)).state, words: transcript?.words.length ?? 0 });
    }
    return out;
  });
  const transcript = await page.evaluate(async (id) => {
    const { getTranscribeService } = (await import(/* @vite-ignore */ "/src/app/".concat("transcribe-service.ts"))) as typeof import("../src/app/transcribe-service");
    return (await getTranscribeService().store.get(id))?.words.map((w) => ({ text: w.text, startSeconds: w.startSeconds, endSeconds: w.endSeconds })) ?? [];
  }, state.promoId);
  state.transcriptWords = transcript;
  await page.screenshot({ path: `${ARTIFACTS}/real-understand.png` });
  log({ stage: "understand", understandSeconds, finishedAt, finalStates, stored, promoTranscriptSample: transcript.slice(0, 60).map((w) => w.text).join(" "), timeline: timeline.filter((_, i) => i % 3 === 0) });
  console.log(`[understand] ${understandSeconds}s final=${JSON.stringify(finalStates)} stored=${JSON.stringify(stored)}`);
  expect(Object.keys(finishedAt).length, "every asset finished understanding (understood or partial)").toBe(total);
  expect(transcript.length, "real Whisper produced words for the promo").toBeGreaterThan(20);
});

test("scenario 4: vertical reframe on the face clip", async () => {
  test.skip(!FACE || !state.faceId || !wanted("vertical-face"), "no face clip configured (FOOTAGE_FACE) or scenario not selected");
  const base = await snapshot();
  await addToTimeline(basename(FACE ?? ""));
  await expect(page.locator("[data-clip-id]")).toHaveCount(2);
  const result = await runScenario("vertical-face", "Make a vertical 9:16 version: set the project to 9:16 and reframe the face.mp4 clip so the speaker's face is centered and fills the frame. Leave the other clips alone.");
  const after = result.after;
  const face = after ? clipsOf(after).find((c) => c.name.includes("face")) : undefined;
  const size = after?.settings.canvasSize;
  const aspect = size ? size.width / size.height : 0;
  const animText = JSON.stringify(face?.animations ?? {});
  const scaleParams = JSON.stringify(face?.params ?? {});
  const checks = { canvas: size, aspect9x16: Math.abs(aspect - 9 / 16) < 0.01, faceAnimationsMentionScale: /scale/i.test(animText), faceAnimations: animText.slice(0, 300), faceParams: scaleParams.slice(0, 300), overlapFree: after ? overlapFree(after) : false, undoRestores: result.undoRestores };
  const pass = result.ran && result.planShown && checks.aspect9x16 && (checks.faceAnimationsMentionScale || /scale/i.test(scaleParams)) && checks.overlapFree && result.undoRestores === true;
  record(result, checks, pass);
  if (result.after && !modelBlocked) await edit("undo");
  if (result.undoRestores !== null) await edit("undo");
  const clean = await snapshot();
  log({ stage: "face-cleanup", restoredToBase: documentKey(clean) === documentKey(base), clips: clipsOf(clean).length });
});

test("scenario 1: transcript highlight around a real phrase", async () => {
  const words = state.transcriptWords;
  test.skip(words.length < 20 || !wanted("transcript"), "no promo transcript or scenario not selected");
  const anchor = words.findIndex((w) => w.startSeconds >= 38 && /^[a-z']{3,}/i.test(w.text.trim()));
  const first = Math.max(0, anchor);
  const slice = words.slice(first, first + 4);
  const phrase = slice.map((w) => w.text.replace(/[^\w']/g, "")).join(" ").trim();
  const truthStart = slice[0]?.startSeconds ?? 0;
  const truth: [number, number] = [truthStart, Math.min(slice[slice.length - 1]?.endSeconds ?? 0, truthStart + 2.5)];
  log({ stage: "scenario-1-phrase", phrase, truth, context: words.slice(Math.max(0, first - 8), first + 12).map((w) => w.text).join(" ") });
  const result = await runScenario("transcript", `Find where the narrator talks about "${phrase}" and cut a roughly 10 second highlight around it.`);
  const after = result.after;
  const kept = after ? keptRanges(after) : [];
  const end = after ? timelineEnd(after) : 0;
  const coverage = covered(kept, state.promoId, truth[0], truth[1]) / Math.max(0.01, truth[1] - truth[0]);
  const spanFrom = Math.min(...kept.map((k) => k.from));
  const spanTo = Math.max(...kept.map((k) => k.to));
  const claimed = [...(result.verification || result.finalText).matchAll(/(\d+(?:\.\d+)?)\s*(?:s\b|sec|seconds)/gi)].map((m) => Number(m[1]));
  const checks = { phrase, truth, timelineEnd: end, phraseCoverage: Math.round(coverage * 100) / 100, sourceSpan: [spanFrom, spanTo], claimedSeconds: claimed, claimMatches: claimed.some((n) => Math.abs(n - end) <= 0.3), overlapFree: after ? overlapFree(after) : false, undoRestores: result.undoRestores };
  const pass = result.planShown && end >= 8 && end <= 12.5 && coverage >= 0.9 && spanTo - spanFrom <= 14 && !!checks.overlapFree && result.undoRestores === true;
  record(result, checks, pass);
  if (result.undoRestores === true && result.redoReapplies) await edit("undo");
});

test("scenario 2: visual search puts the payment shot first, then the confetti shot", async () => {
  test.skip(!wanted("visual"), "scenario not selected");
  const result = await runScenario("visual", "Put the shot with the payment / Allow-Deny screen first, then the confetti shot. Keep only those two shots, each about 4 seconds.");
  const after = result.after;
  const kept = after ? keptRanges(after) : [];
  const idOf = (mid: number): Kept | undefined => kept.find((k) => k.assetId === state.promoId && k.from <= mid && k.to >= mid);
  const payment = idOf((PAYMENT[0] + PAYMENT[1]) / 2);
  const confetti = idOf((CONFETTI[0] + CONFETTI[1]) / 2);
  const checks = {
    paymentRange: PAYMENT, confettiRange: CONFETTI, kept: kept.map((k) => [k.from, k.to, k.start, k.end]),
    paymentPresent: !!payment, confettiPresent: !!confetti,
    paymentFirst: !!payment && kept[0] === payment,
    confettiSecond: !!confetti && kept[1] === confetti,
    overlapFree: after ? overlapFree(after) : false, undoRestores: result.undoRestores,
  };
  const pass = result.planShown && checks.paymentFirst && checks.confettiSecond && !!checks.overlapFree && result.undoRestores === true;
  record(result, checks, pass);
  if (result.undoRestores === true && result.redoReapplies) await edit("undo");
});

test("scenario 3: remove dead air and keep it under 40 seconds", async () => {
  test.skip(!wanted("pace"), "scenario not selected");
  const analysis = await page.evaluate(async ({ id, entryUrl }) => {
    const entry = (await import(/* @vite-ignore */ entryUrl)) as Entry;
    const all = await entry.measureAssets();
    const a = all[id];
    return a ? { silences: a.silences.map((s) => ({ start: s.start, end: s.end })), durationSeconds: a.durationSeconds, speech: a.speechLikeRanges.length } : null;
  }, { id: state.promoId, entryUrl: ENTRY_URL }).catch(() => null);
  log({ stage: "scenario-3-source-analysis", analysis });
  const result = await runScenario("pace", "Remove the dead air and keep the video under 40 seconds.");
  const after = result.after;
  const kept = after ? keptRanges(after) : [];
  const end = after ? timelineEnd(after) : 0;
  const main = kept.filter((k) => k.assetId === state.promoId);
  let gaps = 0;
  for (let i = 1; i < main.length; i++) gaps += Math.max(0, (main[i]?.start ?? 0) - (main[i - 1]?.end ?? 0));
  const silences = (analysis?.silences ?? []).filter((s) => s.end - s.start >= 0.5);
  const silentKept = silences.reduce((sum, s) => sum + covered(main, state.promoId, s.start, s.end), 0);
  const checks = { timelineEnd: end, gapsSeconds: Math.round(gaps * 100) / 100, sourceSilences: silences.length, silentSecondsKept: Math.round(silentKept * 100) / 100, keptSegments: main.length, overlapFree: after ? overlapFree(after) : false, undoRestores: result.undoRestores };
  const pass = result.planShown && end > 5 && end <= 40.05 && gaps <= 0.1 && silentKept <= 1 && !!checks.overlapFree && result.undoRestores === true;
  record(result, checks, pass);
});

test("scenario 5: export the edited timeline with the real exporter and decode it", async () => {
  test.setTimeout(900_000);
  let scriptedEdit = false;
  const current = await snapshot();
  const untouched = clipsOf(current).length === 1 && (clipsOf(current)[0]?.duration ?? 0) > 60;
  if (untouched) {
    // No model scenario left an edit (budget): replay the visual scenario's cut through the same tools, without a model call.
    scriptedEdit = await page.evaluate(async ({ promoId, payment, confetti }) => {
      const { getServices } = (await import(/* @vite-ignore */ "/src/app/".concat("services.ts"))) as typeof import("../src/app/services");
      const { createBridgeRegistry } = (await import(/* @vite-ignore */ "/src/app/".concat("agent-bridge-wiring.ts"))) as typeof import("../src/app/agent-bridge-wiring");
      const { callTool } = (await import(/* @vite-ignore */ "/src/engine/agent/".concat("index.ts"))) as typeof import("../src/engine/agent");
      const { editor } = getServices();
      const tools = createBridgeRegistry(() => undefined);
      const ctx = { editor, nowMs: () => Date.now() };
      const ids = (editor.toProject().scenes[0]?.tracks.main.elements ?? []).map((e) => e.id);
      const removed = await callTool({ tools, name: "delete", args: { elementIds: ids }, ctx });
      const cut = await callTool({ tools, name: "cut_to_moments", args: { moments: [{ assetId: promoId, startSeconds: payment[0], endSeconds: payment[1] }, { assetId: promoId, startSeconds: confetti[0], endSeconds: confetti[1] }] }, ctx });
      return removed.ok && cut.ok;
    }, { promoId: state.promoId, payment: [PAYMENT[0], PAYMENT[0] + 4], confetti: [CONFETTI[0], CONFETTI[0] + 4] });
  }
  const doc = await snapshot();
  if (clipsOf(doc).length === 0) throw new Error("empty timeline");
  const expected = timelineEnd(doc);
  const clips = keptRanges(doc);
  await page.getByRole("button", { name: "Export", exact: true }).first().click();
  const downloadPromise = page.waitForEvent("download", { timeout: 600_000 });
  const started = Date.now();
  await page.getByRole("dialog", { name: "Export project" }).getByRole("button", { name: "Export" }).click();
  const download = await downloadPromise;
  const exportSeconds = (Date.now() - started) / 1000;
  exportPath = (await download.path()) ?? "";
  const sizeMb = statSync(exportPath).size / 1e6;

  const url = await mediabunnyModuleUrl(page);
  const times = [0.5, expected / 2, Math.max(0.6, expected - 1)].map((t) => Math.min(t, Math.max(0.1, expected - 0.2)));
  const mapped = times.map((t) => {
    const clip = clips.find((c) => t >= c.start && t < c.end);
    return clip && clip.assetId === state.promoId ? { t, source: clip.from + (t - clip.start) } : null;
  });
  const probe = await page.evaluate(async ({ url, exportUrl, sourceUrl, pairs, offset }) => {
    const mb = (await import(/* @vite-ignore */ url)) as typeof import("mediabunny");
    const open = async (u: string) => new mb.Input({ source: new mb.BlobSource(await (await fetch(u)).blob()), formats: mb.ALL_FORMATS });
    const signature = async (input: InstanceType<typeof mb.Input>, t: number): Promise<number[]> => {
      const track = await input.getPrimaryVideoTrack();
      const frame = await new mb.CanvasSink(track!).getCanvas(t);
      const small = new OffscreenCanvas(32, 18);
      const ctx = small.getContext("2d") as OffscreenCanvasRenderingContext2D;
      ctx.drawImage(frame!.canvas as CanvasImageSource, 0, 0, 32, 18);
      const d = ctx.getImageData(0, 0, 32, 18).data;
      return Array.from({ length: 32 * 18 }, (_, i) => ((d[i * 4] ?? 0) + (d[i * 4 + 1] ?? 0) + (d[i * 4 + 2] ?? 0)) / 3);
    };
    const diff = (a: number[], b: number[]): number => a.reduce((s, v, i) => s + Math.abs(v - (b[i] ?? 0)), 0) / a.length;
    const exported = await open(exportUrl);
    const source = await open(sourceUrl);
    const video = await exported.getPrimaryVideoTrack();
    const audio = await exported.getPrimaryAudioTrack();
    const frames: Array<{ t: number; source: number; diffRight: number; diffWrong: number; mean: number }> = [];
    for (const p of pairs) {
      if (!p) continue;
      const got = await signature(exported, p.t);
      const right = await signature(source, p.source);
      const wrong = await signature(source, (p.source + offset) % 80);
      frames.push({ t: p.t, source: p.source, diffRight: diff(got, right), diffWrong: diff(got, wrong), mean: got.reduce((s, v) => s + v, 0) / got.length });
    }
    let rmsWindows: number[] = [];
    let audioCodec: string | null = null;
    if (audio) {
      audioCodec = audio.codec;
      const sink = new mb.AudioBufferSink(audio);
      const sums: number[] = [];
      const counts: number[] = [];
      for await (const { buffer, timestamp } of sink.buffers(0)) {
        const ch = buffer.getChannelData(0);
        const bin = Math.floor(timestamp);
        let s = 0;
        for (let i = 0; i < ch.length; i++) s += (ch[i] ?? 0) ** 2;
        sums[bin] = (sums[bin] ?? 0) + s;
        counts[bin] = (counts[bin] ?? 0) + ch.length;
      }
      rmsWindows = sums.map((s, i) => Math.sqrt(s / Math.max(1, counts[i] ?? 1)));
    }
    return {
      duration: await exported.computeDuration(), width: await video!.getDisplayWidth(), height: await video!.getDisplayHeight(), videoCodec: video!.codec, audioCodec,
      audioDuration: audio ? await audio.computeDuration() : null, frames, rmsWindows,
    };
  }, { url, exportUrl: "/__real/export.mp4", sourceUrl: "/__real/promo.mp4", pairs: mapped, offset: 9 });

  const audible = probe.rmsWindows.filter((r) => r > 0.005).length;
  const checks = {
    exportSeconds, sizeMb: Math.round(sizeMb * 10) / 10, expectedDuration: expected, decodedDuration: probe.duration, width: probe.width, height: probe.height,
    videoCodec: probe.videoCodec, audioCodec: probe.audioCodec, audioDuration: probe.audioDuration, audibleSeconds: audible, windows: probe.rmsWindows.length,
    frames: probe.frames.map((f) => ({ ...f, diffRight: Math.round(f.diffRight * 10) / 10, diffWrong: Math.round(f.diffWrong * 10) / 10, mean: Math.round(f.mean) })),
  };
  const settings = doc.settings.canvasSize;
  const pass = Math.abs(probe.duration - expected) <= 0.3 && probe.width === settings.width && probe.height === settings.height
    && probe.audioCodec !== null && audible >= probe.rmsWindows.length * 0.5 && probe.frames.length > 0 && probe.frames.every((f) => f.diffRight < f.diffWrong && f.mean > 5);
  log({ scenario: "export", scriptedEdit, checks, pass, canvas: settings });
  console.log(`[export] ${pass ? "PASS" : "FAIL"} ${JSON.stringify(checks)}`);
  expect(probe.duration).toBeGreaterThan(0);
});

test("report budget", () => {
  log({ stage: "budget", totalCostUsd: Math.round(spent * 10_000) / 10_000, modelBlocked, model: MODEL_ID, pricingPerMTok: PRICING });
  console.log(`[budget] total $${spent.toFixed(4)} blocked=${modelBlocked ?? "no"}`);
});
