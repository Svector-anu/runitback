import { expect, test, type Locator, type Page } from "@playwright/test";
import { importGenerated, makeWebm } from "./media";

test.use({ channel: "chrome" });

const SHOTS = "e2e/.artifacts/panel";
const VIEWPORTS = [
  { width: 1280, height: 720 },
  { width: 1440, height: 900 },
  { width: 1920, height: 1080 },
] as const;
const MANY_STEPS = 8;

async function openAgent(page: Page, withClip: boolean): Promise<Locator> {
  await page.goto("/#/projects");
  await page.getByRole("button", { name: "Create your first project" }).click();
  await expect(page).toHaveURL(/#\/editor\//);
  if (withClip) {
    await makeWebm(page, { seconds: 3, hue: 200, name: "agent-a.webm", withAudio: true });
    await importGenerated(page);
    await page.getByRole("button", { name: "Add agent-a.webm to timeline" }).click({ force: true });
    await expect(page.locator("[data-clip-id]")).toHaveCount(1);
  }
  await page.getByRole("tab", { name: "Agent" }).click();
  return page.getByTestId("agent-panel");
}

async function installPlanModel(page: Page, stepCount: number): Promise<void> {
  await page.evaluate(async (count) => {
    const url = "/src/app/agent/model-client.ts";
    const { ScriptedModelClient } = (await import(/* @vite-ignore */ url)) as typeof import("../src/app/agent/model-client");
    const use = (id: string, name: string, input: unknown) => ({ type: "tool_use" as const, id, name, input });
    const steps = Array.from({ length: count }, (_, i) => ({
      intent: `Step ${i + 1}: trim the dead air before the second beat and keep the audio in sync`,
      tools: ["split", "insert_media"],
      targets: ["clip agent-a.webm on the main track"],
      check: "get_timeline shows no gap",
    }));
    const plan = { summary: "Tighten the opening by removing dead air, then verify the cut points.", steps };
    (globalThis as unknown as { __agentModel?: unknown }).__agentModel = new ScriptedModelClient([
      { content: [use("c1", "propose_plan", plan)] },
      () => ({ content: [use("c2", "update_plan_step", { step: 1, status: "running" })] }),
      { content: [use("c3", "update_plan_step", { step: 1, status: "done", note: "trimmed" })] },
      { content: [{ type: "text", text: "Done.\nVerification: the opening has no gap." }] },
    ]);
  }, stepCount);
}

interface ControlReport {
  name: string;
  inViewport: boolean;
  inPanel: boolean;
  covered: boolean;
}

/**
 * Every actionable control outside the scrolling regions (the chat log and the plan's step list) is fully inside the
 * viewport and the panel, and is the topmost element at its centre. Measured in one pass so a running agent cannot race it.
 */
async function expectNothingClipped(page: Page, panel: Locator): Promise<void> {
  const reports = await panel.evaluate((root): ControlReport[] => {
    const panelRect = root.getBoundingClientRect();
    const out: ControlReport[] = [];
    for (const el of root.querySelectorAll<HTMLElement>("button, input, select, textarea, summary")) {
      if (el.closest(".agent-log, .agent-plan__body, .agent-sr-only")) continue;
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      out.push({
        name: el.getAttribute("aria-label") ?? (el.textContent?.trim().slice(0, 30) || `${el.tagName} ${el.id}`),
        inViewport: rect.left >= -1 && rect.top >= -1 && rect.right <= window.innerWidth + 1 && rect.bottom <= window.innerHeight + 1,
        inPanel: rect.left >= panelRect.left - 1 && rect.top >= panelRect.top - 1 && rect.right <= panelRect.right + 1 && rect.bottom <= panelRect.bottom + 1,
        covered: hit === null || !(el === hit || el.contains(hit) || hit.contains(el)),
      });
    }
    return out;
  });
  expect(reports.length).toBeGreaterThan(3);
  for (const r of reports) {
    expect(r.inViewport, `"${r.name}" is inside the viewport`).toBe(true);
    expect(r.inPanel, `"${r.name}" is inside the panel`).toBe(true);
    expect(r.covered, `"${r.name}" is not covered by another element`).toBe(false);
  }
  void page;
}

for (const viewport of VIEWPORTS) {
  const tag = `${viewport.width}x${viewport.height}`;

  test(`${tag}: key missing shows one hint line and nothing clips; the chat log keeps real height`, async ({ page }) => {
    await page.setViewportSize(viewport);
    const panel = await openAgent(page, false);
    const hint = panel.getByTestId("agent-key-hint");
    await expect(hint).toBeVisible();
    expect((await hint.boundingBox())?.height ?? 0).toBeLessThan(40);
    await expect(panel.getByText(/kept in this browser only/)).toBeHidden();
    await page.screenshot({ path: `${SHOTS}/${tag}-1-no-key.png` });
    await expectNothingClipped(page, panel);
    expect((await panel.getByRole("log").boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(viewport.height >= 900 ? 120 : 60);

    await panel.getByLabel("Anthropic API key").fill("sk-ant-test");
    await expect(panel.getByTestId("agent-settings-summary")).toBeVisible();
    await expectNothingClipped(page, panel);
    expect((await panel.getByRole("log").boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(viewport.height >= 900 ? 180 : 120);
    await page.screenshot({ path: `${SHOTS}/${tag}-2-key-set.png` });

    await panel.getByRole("button", { name: "Agent settings" }).click();
    await expect(panel.getByLabel("Ask before editing")).toBeInViewport({ ratio: 1 });
    await expectNothingClipped(page, panel);
    await page.screenshot({ path: `${SHOTS}/${tag}-3-settings-open.png` });
    await panel.getByText("Privacy and cost").click();
    await expect(panel.getByRole("button", { name: "Send" })).toBeInViewport({ ratio: 1 });
    await page.screenshot({ path: `${SHOTS}/${tag}-3b-privacy-open.png` });
  });

  test(`${tag}: a long plan docks above the composer with Approve focused and every action visible`, async ({ page }) => {
    await page.setViewportSize(viewport);
    const panel = await openAgent(page, true);
    await panel.getByLabel("Anthropic API key").fill("sk-ant-test");
    await expect(panel.getByTestId("agent-settings-summary")).toBeVisible();
    await installPlanModel(page, MANY_STEPS);
    await panel.getByLabel("Message to the agent").fill("Tighten the opening");
    await panel.getByRole("button", { name: "Send" }).click();

    const plan = panel.getByTestId("agent-plan");
    await expect(plan).toHaveAttribute("data-status", "awaiting");
    await expect(plan.getByTestId("agent-plan-step")).toHaveCount(MANY_STEPS);
    await page.screenshot({ path: `${SHOTS}/${tag}-4-plan-docked.png` });
    const approve = plan.getByRole("button", { name: "Approve" });
    await expect(approve).toBeFocused();
    await expect(panel.getByRole("status").filter({ hasText: "Plan ready for your approval" })).toHaveCount(1);
    await expect(plan.getByRole("button", { name: "Edit" })).toBeInViewport({ ratio: 1 });
    await expect(plan.getByRole("button", { name: "Reject" })).toBeInViewport({ ratio: 1 });
    await expect(panel.getByLabel("Message to the agent")).toBeInViewport({ ratio: 1 });
    await expect(panel.getByRole("button", { name: "Send" })).toBeInViewport({ ratio: 1 });

    const panelBox = await panel.boundingBox();
    const planBox = await plan.boundingBox();
    const composerBox = await panel.getByLabel("Message to the agent").boundingBox();
    expect(planBox && panelBox && planBox.height <= Math.max(panelBox.height * 0.46, 152) + 2).toBe(true);
    expect(planBox && composerBox && planBox.y + planBox.height <= composerBox.y + 1).toBe(true);
    const body = plan.locator(".agent-plan__body");
    expect(await body.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
    await expectNothingClipped(page, panel);

    await page.keyboard.press("Enter");
    await expect(plan).toHaveAttribute("data-status", "approved");
    await expect(plan.getByTestId("agent-plan-verification")).toContainText("no gap");
    await expect(plan.getByTestId("agent-plan-step").first()).toHaveAttribute("data-status", "done");
    await expect(panel.getByRole("button", { name: "Stop" })).toHaveCount(0);
    await plan.getByTestId("agent-plan-verification").scrollIntoViewIfNeeded();
    await expectNothingClipped(page, panel);
    await page.screenshot({ path: `${SHOTS}/${tag}-5-verified.png` });
  });
}
