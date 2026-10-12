import { expect, test, type Page } from "@playwright/test";
import { importGenerated, makeWebm } from "./media";

const SHOTS = "e2e/.artifacts/ux";

async function newProject(page: Page, path = "/#/projects"): Promise<void> {
  await page.goto(path);
  await page.getByRole("button", { name: /New project|Create your first project/ }).first().click();
  await expect(page.getByLabel("Project name")).toBeVisible();
}

async function importClip(page: Page, name: string): Promise<void> {
  await makeWebm(page, { seconds: 2, hue: 120, name });
  await importGenerated(page);
  await expect(page.getByRole("group", { name: new RegExp(`video ${name}`) })).toBeVisible({ timeout: 30_000 });
}

test("landing explains what it is, how it works, the requirements, and has a clear start button", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Tell your video editor what to do" })).toBeVisible();
  const how = page.getByRole("region", { name: "How it works" });
  for (const step of ["Import", "Understand", "Tell it what to do", "Review the plan", "Export"]) await expect(how.getByText(step, { exact: true })).toBeVisible();
  await expect(page.getByText("Works in Chrome")).toBeVisible();
  await expect(page.getByText("Bring your own Anthropic API key")).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/ux-01-landing.png`, fullPage: true });
  await page.getByRole("button", { name: "Start editing" }).click();
  await expect(page).toHaveURL(/\/app/);
});

test("guided tour: opens once for a first-time user, walks five stops by keyboard, never returns, Help reopens it", async ({ page }) => {
  await newProject(page, "/app?tour=1");
  const tour = page.getByTestId("tour");
  await expect(tour).toBeVisible();
  await expect(tour).toContainText("Import your footage");
  await expect(tour.getByRole("button", { name: "Next" })).toBeFocused();
  await page.screenshot({ path: `${SHOTS}/ux-02-tour-import.png` });

  const stops = ["understand", "agent", "timeline", "export"];
  for (const stop of stops) {
    await page.keyboard.press("ArrowRight");
    await expect(tour).toHaveAttribute("data-step", stop);
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${SHOTS}/ux-0${3 + stops.indexOf(stop)}-tour-${stop}.png` });
  }
  await expect(tour.getByRole("button", { name: "Done" })).toBeVisible();
  await page.keyboard.press("ArrowLeft");
  await expect(tour).toHaveAttribute("data-step", "timeline");
  await page.keyboard.press("Escape");
  await expect(tour).toBeHidden();

  await page.waitForTimeout(1200);
  await page.reload();
  await expect(page.getByLabel("Project name")).toBeVisible();
  await expect(page.getByTestId("tour")).toBeHidden();

  await page.getByTestId("help-button").click();
  await page.getByRole("menuitem", { name: "Take the tour" }).click();
  await expect(page.getByTestId("tour")).toBeVisible();
  await page.getByRole("button", { name: "Skip tour" }).click();
  await expect(page.getByTestId("tour")).toBeHidden();
  await expect(page.getByTestId("help-button")).toBeFocused();
});

test("the tour stays out of the way of automated sessions unless ?tour is set", async ({ page }) => {
  await newProject(page);
  await expect(page.getByTestId("tour")).toBeHidden();
});

test("empty states say what to do, and the first clip triggers a one-time tip", async ({ page }) => {
  await newProject(page);
  await expect(page.getByText("Drag and drop videos, photos, and audio files here")).toBeVisible();
  await expect(page.getByText(/Files stay in this browser and are never uploaded/)).toBeVisible();
  await expect(page.getByTestId("timeline-empty-hint")).toContainText("Drag a clip here");
  await expect(page.getByRole("button", { name: /^Export$/ })).toBeDisabled();
  await page.screenshot({ path: `${SHOTS}/ux-07-empty-editor.png` });

  await importClip(page, "ux-a.webm");
  const intro = page.getByTestId("understand-hint");
  await expect(intro).toContainText("about 50 MB");
  await expect(intro).toContainText("about 156 MB");
  await expect(intro).toContainText("nothing is uploaded");
  await page.screenshot({ path: `${SHOTS}/ux-08-understand-intro.png` });

  await page.getByRole("button", { name: "Add ux-a.webm to timeline" }).click({ force: true });
  await expect(page.locator("[data-clip-id]")).toHaveCount(1);
  await expect(page.getByTestId("timeline-empty-hint")).toHaveCount(0);
  const tip = page.getByText("Press Space to play, S to split at the playhead");
  await expect(tip).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/ux-09-first-clip-tip.png` });

  await intro.getByRole("button", { name: "Dismiss this tip" }).click();
  await expect(intro).toBeHidden();
  await page.waitForTimeout(1200);
  await page.reload();
  await expect(page.getByLabel("Project name")).toBeVisible();
  await expect(page.getByTestId("understand-hint")).toBeHidden();

  await page.getByTestId("help-button").click();
  await page.getByRole("menuitem", { name: "Show tips again" }).click();
  await expect(page.getByTestId("understand-hint")).toBeVisible();
});

test("a mouse click on a tile's + does not leave focus there, so Space plays instead of adding another clip", async ({ page }) => {
  await newProject(page);
  await importClip(page, "ux-b.webm");
  await page.getByRole("button", { name: "Add ux-b.webm to timeline" }).click({ force: true });
  await expect(page.locator("[data-clip-id]")).toHaveCount(1);
  await page.keyboard.press("Space");
  await page.waitForTimeout(300);
  await expect(page.locator("[data-clip-id]")).toHaveCount(1);
});

test("icon-only buttons explain themselves on hover and keyboard focus", async ({ page }) => {
  await newProject(page);
  await page.getByRole("button", { name: "Switch to list view" }).hover();
  await expect(page.getByRole("tooltip")).toContainText("Switch to list view");
  await page.getByRole("button", { name: "Zoom in preview" }).hover();
  await expect(page.getByRole("tooltip")).toContainText("Zoom in preview");
  await page.getByRole("button", { name: /^Export$/ }).locator("xpath=..").hover();
  await expect(page.getByRole("tooltip")).toContainText("Add a clip to the timeline to enable export");
  await page.screenshot({ path: `${SHOTS}/ux-10-export-disabled-tooltip.png` });
});

test("agent panel: key help links to the Anthropic console, typing a key keeps the field, and the panel scrolls on short screens", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 640 });
  await newProject(page);
  await page.getByRole("tab", { name: "Agent" }).click();
  const panel = page.getByTestId("agent-panel");
  const link = panel.getByRole("link", { name: "Where do I get a key?" });
  await expect(link).toHaveAttribute("href", "https://console.anthropic.com/settings/keys");
  await expect(panel.getByText(/kept in this browser only and is sent only to Anthropic/)).toBeVisible();
  await expect(panel.getByText(/You pay Anthropic directly/)).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/ux-11-agent-key-help.png` });

  const key = panel.getByLabel("Anthropic API key");
  await key.click();
  await page.keyboard.type("sk-ant-typed-by-hand", { delay: 25 });
  await expect(key).toHaveValue("sk-ant-typed-by-hand");

  await panel.getByLabel("Message to the agent").scrollIntoViewIfNeeded();
  await expect(panel.getByRole("button", { name: "Send" })).toBeInViewport();
});

test("the plan card explains itself the first time, and the explanation can be dismissed for good", async ({ page }) => {
  await newProject(page);
  await page.getByRole("tab", { name: "Agent" }).click();
  await page.evaluate(async () => {
    const url = "/src/app/agent/model-client.ts";
    const { ScriptedModelClient } = (await import(/* @vite-ignore */ url)) as typeof import("../src/app/agent/model-client");
    const use = (id: string, name: string, input: unknown) => ({ type: "tool_use" as const, id, name, input });
    const plan = { summary: "Tidy the timeline.", steps: [{ intent: "Do a thing", tools: ["insert_media"], targets: ["asset a"], check: "get_timeline" }] };
    (globalThis as unknown as { __agentModel?: unknown }).__agentModel = new ScriptedModelClient([{ content: [use("c1", "propose_plan", plan)] }]);
  });
  const panel = page.getByTestId("agent-panel");
  await panel.getByLabel("Anthropic API key").fill("sk-ant-test");
  await panel.getByLabel("Message to the agent").fill("Tidy up");
  await panel.getByRole("button", { name: "Send" }).click();
  const hint = panel.getByTestId("plan-hint");
  await expect(hint).toContainText("not an edit yet");
  await page.screenshot({ path: `${SHOTS}/ux-12-plan-card-hint.png` });
  await hint.getByRole("button", { name: "Dismiss this tip" }).click();
  await expect(hint).toBeHidden();
});
