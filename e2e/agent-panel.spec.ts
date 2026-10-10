import { expect, test, type Page } from "@playwright/test";
import { importGenerated, makeWebm } from "./media";

/** Installs a scripted model through the dev-only `window.__agentModel` hook; no network is involved. */
async function installScriptedModel(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const url = "/src/app/agent/model-client.ts";
    const { ScriptedModelClient } = (await import(/* @vite-ignore */ url)) as typeof import("../src/app/agent/model-client");
    type Request = import("../src/app/agent/model-client").ModelRequest;
    const use = (id: string, name: string, input: unknown) => ({ type: "tool_use" as const, id, name, input });
    const lastText = (request: Request): string => {
      const last = request.messages[request.messages.length - 1];
      const block = last?.role === "user" ? last.content[0] : undefined;
      const inner = block?.type === "tool_result" ? block.content[0] : undefined;
      return inner?.type === "text" ? inner.text : "";
    };
    const model = new ScriptedModelClient([
      { content: [{ type: "text", text: "Looking at your media first." }, use("c1", "list_assets", {})] },
      (request: Request) => {
        const data = JSON.parse(lastText(request).split("\n")[1] ?? "{}") as { assets: Array<{ id: string; usedOnTimeline: boolean }> };
        const unused = data.assets.find((a) => !a.usedOnTimeline);
        return { content: [use("c2", "insert_media", { assetId: unused?.id }), use("c3", "split", { at: 1.5 })] };
      },
      { content: [use("c4", "render_frame", { time: 1 })] },
      { content: [{ type: "text", text: "Added the second clip, cut the first at 1.5s and checked the frame." }] },
    ]);
    (globalThis as unknown as { __agentModel?: unknown }).__agentModel = model;
  });
}

const ASK_PREF_KEY = "runitback:agent-ask-before-editing";

async function openProjectWithClip(page: Page): Promise<void> {
  await page.goto("/#/projects");
  await page.getByRole("button", { name: "Create your first project" }).click();
  await expect(page).toHaveURL(/#\/editor\//);
  await makeWebm(page, { seconds: 3, hue: 200, name: "agent-a.webm", withAudio: true });
  await makeWebm(page, { seconds: 3, hue: 20, name: "agent-b.webm" });
  await importGenerated(page);
  await page.getByRole("button", { name: "Add agent-a.webm to timeline" }).click({ force: true });
  await expect(page.locator("[data-clip-id]")).toHaveCount(1);
  await page.getByRole("tab", { name: "Agent" }).click();
}

test("the in-app agent edits the timeline, shows a rendered frame and one undo reverts the turn", async ({ page }) => {
  await page.addInitScript((key) => localStorage.setItem(key, "false"), ASK_PREF_KEY);
  await page.goto("/#/projects");
  await page.getByRole("button", { name: "Create your first project" }).click();
  await expect(page).toHaveURL(/#\/editor\//);
  await makeWebm(page, { seconds: 3, hue: 200, name: "agent-a.webm", withAudio: true });
  await makeWebm(page, { seconds: 3, hue: 20, name: "agent-b.webm" });
  await importGenerated(page);
  await page.getByRole("button", { name: "Add agent-a.webm to timeline" }).click({ force: true });
  await expect(page.locator("[data-clip-id]")).toHaveCount(1);

  await page.getByRole("tab", { name: "Agent" }).click();
  const panel = page.getByTestId("agent-panel");
  await expect(panel).toBeVisible();
  await expect(panel.getByTestId("agent-empty")).toBeVisible();
  await expect(panel.getByRole("list", { name: "Example prompts" }).getByRole("button")).toHaveCount(4);
  await expect(panel.getByText(/kept in this browser only and is sent only to Anthropic/)).toBeVisible();
  await expect(panel.getByLabel("Anthropic API key")).toHaveAttribute("type", "password");
  await expect(panel.getByRole("button", { name: "Undo agent changes" })).toBeDisabled();

  await installScriptedModel(page);
  await panel.getByLabel("Message to the agent").fill("Add the other clip and check it");
  await panel.getByRole("button", { name: "Send" }).click();

  await expect(panel.getByTestId("agent-assistant-text").last()).toContainText("checked the frame");
  await expect(page.locator("[data-clip-id]")).toHaveCount(3);

  const chips = panel.getByTestId("agent-tool-chip");
  await expect(chips).toHaveCount(4);
  await expect(chips.first()).toHaveAttribute("data-tool", "list_assets");
  await expect(chips.nth(3)).toHaveAttribute("data-status", "ok");
  await chips.nth(1).locator("summary").click();
  await expect(chips.nth(1)).toContainText("assetId");

  const frame = panel.getByTestId("agent-frame");
  await expect(frame).toHaveCount(1);
  expect(await frame.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0 && Math.max(img.naturalWidth, img.naturalHeight) <= 1024)).toBe(true);

  const undo = panel.getByRole("button", { name: "Undo agent changes" });
  await expect(undo).toBeEnabled();
  await undo.click();
  await expect(page.locator("[data-clip-id]")).toHaveCount(1);
  await expect(undo).toBeDisabled();
});

test("without a key and without a test model the panel asks for the key and edits nothing", async ({ page }) => {
  await page.goto("/#/projects");
  await page.getByRole("button", { name: "Create your first project" }).click();
  await expect(page).toHaveURL(/#\/editor\//);
  await page.getByRole("tab", { name: "Agent" }).click();
  const panel = page.getByTestId("agent-panel");
  await expect(panel.getByTestId("agent-key-hint")).toContainText("API key is required");
  await panel.getByLabel("Anthropic API key").fill("sk-ant-test");
  await expect(panel.getByTestId("agent-key-hint")).toHaveCount(0);
  await expect(panel.getByTestId("agent-settings-summary")).toBeVisible();
  await panel.getByRole("button", { name: "Change", exact: true }).click();
  await panel.getByLabel("Anthropic API key").fill("");
  await expect(panel.getByTestId("agent-key-hint")).toBeVisible();
  await panel.getByLabel("Message to the agent").fill("hello");
  await panel.getByRole("button", { name: "Send" }).click();
  await expect(panel.getByRole("alert")).toContainText("API key");
});

test("settings collapse to a compact row once a key is set, keep the chat log readable, and Change restores full controls", async ({ page }) => {
  // A generous (but in-range, see PANEL_CONSTRAINTS.vertical max:85) top-row split, same as a
  // returning user who has resized their panes via `src/platform/prefs.ts`'s "panel-sizes" key —
  // isolates this assertion from the unrelated default 50/50 split's own fixed overhead.
  await page.addInitScript(() => {
    localStorage.setItem("runitback:panel-sizes", JSON.stringify({ horizontal: [25, 50, 25], vertical: [75, 25] }));
  });
  await page.goto("/#/projects");
  await page.getByRole("button", { name: "Create your first project" }).click();
  await expect(page).toHaveURL(/#\/editor\//);
  await page.getByRole("tab", { name: "Agent" }).click();
  const panel = page.getByTestId("agent-panel");

  // No key yet: full settings block, same as before this change.
  await expect(panel.getByLabel("Model")).toBeVisible();
  await expect(panel.getByLabel("Anthropic API key")).toBeVisible();
  await expect(panel.getByTestId("agent-settings-summary")).toHaveCount(0);

  await panel.getByLabel("Anthropic API key").fill("sk-ant-test");

  // Settings collapse to one row; model name stays visible, key does not.
  const summary = panel.getByTestId("agent-settings-summary");
  await expect(summary).toBeVisible();
  await expect(summary).not.toContainText("sk-ant-test");
  await expect(panel.getByLabel("Anthropic API key")).toHaveCount(0);
  const toggle = panel.getByRole("button", { name: "Change", exact: true });
  await expect(toggle).toHaveAttribute("aria-expanded", "false");

  // Chat log reclaims the space the settings block used to occupy.
  const logBox = await panel.getByRole("log", { name: "Agent conversation" }).boundingBox();
  expect(logBox?.height ?? 0).toBeGreaterThanOrEqual(300);

  // Change re-expands the settings; key field and model select are reachable again.
  await toggle.click();
  await expect(panel.getByTestId("agent-settings-summary")).toHaveCount(0);
  await expect(panel.getByLabel("Model")).toBeVisible();
  await expect(panel.getByLabel("Anthropic API key")).toBeVisible();
  const doneToggle = panel.getByRole("button", { name: "Done", exact: true });
  await expect(doneToggle).toHaveAttribute("aria-expanded", "true");

  await doneToggle.click();
  await expect(panel.getByTestId("agent-settings-summary")).toBeVisible();
});

test("with Ask before editing on, the panel shows the plan, edits nothing until Approve, then runs it with verified steps", async ({ page }) => {
  await openProjectWithClip(page);
  const panel = page.getByTestId("agent-panel");
  await expect(panel.getByLabel("Ask before editing")).toBeChecked();

  await page.evaluate(async (intent) => {
    const url = "/src/app/agent/model-client.ts";
    const { ScriptedModelClient } = (await import(/* @vite-ignore */ url)) as typeof import("../src/app/agent/model-client");
    type Request = import("../src/app/agent/model-client").ModelRequest;
    const use = (id: string, name: string, input: unknown) => ({ type: "tool_use" as const, id, name, input });
    const resultText = (request: Request): string => {
      const last = request.messages[request.messages.length - 1];
      const block = last?.role === "user" ? last.content[0] : undefined;
      const inner = block?.type === "tool_result" ? block.content[0] : undefined;
      return inner?.type === "text" ? inner.text : "";
    };
    let assetId = "";
    const model = new ScriptedModelClient([
      { content: [use("c1", "list_assets", {})] },
      (request: Request) => {
        const data = JSON.parse(resultText(request).split("\n")[1] ?? "{}") as { assets: Array<{ id: string; usedOnTimeline: boolean }> };
        assetId = data.assets.find((a) => !a.usedOnTimeline)?.id ?? "";
        const steps = {
          summary: "Append the second clip to the main track.",
          steps: [{ intent, tools: ["insert_media"], targets: [`asset ${assetId}`], check: "get_timeline lists two clips on the main track" }],
        };
        return { content: [use("c2", "propose_plan", steps)] };
      },
      () => ({ content: [use("c3", "update_plan_step", { step: 1, status: "running" }), use("c4", "insert_media", { assetId })] }),
      { content: [use("c5", "update_plan_step", { step: 1, status: "done", note: "timeline now has 2 clips" })] },
      { content: [{ type: "text", text: "Added the clip.\nVerification: 2 clips on the timeline." }] },
    ]);
    (globalThis as unknown as { __agentModel?: unknown }).__agentModel = model;
  }, "Add agent-b.webm after the first clip");
  await panel.getByLabel("Message to the agent").fill("Add the other clip after the first one");
  await panel.getByRole("button", { name: "Send" }).click();

  const plan = panel.getByTestId("agent-plan");
  await expect(plan).toBeVisible();
  await expect(plan).toHaveAttribute("data-status", "awaiting");
  await expect(plan.getByTestId("agent-plan-step")).toHaveCount(1);
  await expect(plan).toContainText("Add agent-b.webm after the first clip");
  await expect(plan).toContainText("Tools: insert_media");
  await expect(plan).toContainText("Check: get_timeline lists two clips");
  await expect(page.locator("[data-clip-id]")).toHaveCount(1);
  await expect(panel.getByRole("button", { name: "Undo agent changes" })).toBeDisabled();

  await plan.getByRole("button", { name: "Approve" }).click();
  await expect(plan).toHaveAttribute("data-status", "approved");
  await expect(plan.getByTestId("agent-plan-step")).toHaveAttribute("data-status", "done");
  await expect(plan.getByTestId("agent-plan-note")).toContainText("2 clips");
  await expect(plan.getByTestId("agent-plan-verification")).toContainText("2 clips on the timeline");
  await expect(page.locator("[data-clip-id]")).toHaveCount(2);
  await expect(panel.getByTestId("agent-tool-chip")).toHaveCount(2);

  const undo = panel.getByRole("button", { name: "Undo agent changes" });
  await undo.click();
  await expect(page.locator("[data-clip-id]")).toHaveCount(1);
});

test("Edit sends free-text changes back for a revised plan; Reject leaves the project untouched", async ({ page }) => {
  await openProjectWithClip(page);
  const panel = page.getByTestId("agent-panel");
  await page.evaluate(async () => {
    const url = "/src/app/agent/model-client.ts";
    const { ScriptedModelClient } = (await import(/* @vite-ignore */ url)) as typeof import("../src/app/agent/model-client");
    type Request = import("../src/app/agent/model-client").ModelRequest;
    const use = (id: string, name: string, input: unknown) => ({ type: "tool_use" as const, id, name, input });
    const plan = (intent: string) => ({ summary: "Change the timeline.", steps: [{ intent, tools: ["insert_media"], targets: ["asset a"], check: "get_timeline" }] });
    const feedbackOf = (request: Request): string => {
      const last = request.messages[request.messages.length - 1];
      const block = last?.role === "user" ? last.content[0] : undefined;
      const inner = block?.type === "tool_result" ? block.content[0] : undefined;
      return inner?.type === "text" ? inner.text : "";
    };
    const model = new ScriptedModelClient([
      { content: [use("c1", "propose_plan", plan("First draft"))] },
      (request: Request) => ({ content: [use("c2", "propose_plan", plan(`Revised: ${feedbackOf(request).includes("keep it short") ? "short version" : "feedback lost"}`))] }),
    ]);
    (globalThis as unknown as { __agentModel?: unknown }).__agentModel = model;
  });
  await panel.getByLabel("Message to the agent").fill("Do something to the timeline");
  await panel.getByRole("button", { name: "Send" }).click();

  const first = panel.getByTestId("agent-plan").first();
  await expect(first).toContainText("First draft");
  await first.getByRole("button", { name: "Edit" }).click();
  await expect(first.getByRole("button", { name: "Send changes" })).toBeDisabled();
  await first.getByLabel("What should change in the plan?").fill("keep it short");
  await first.getByRole("button", { name: "Send changes" }).click();

  await expect(panel.getByTestId("agent-plan")).toHaveCount(2);
  const revised = panel.getByTestId("agent-plan").last();
  await expect(revised).toContainText("Revised: short version");
  await expect(first).toHaveAttribute("data-status", "superseded");
  await expect(page.locator("[data-clip-id]")).toHaveCount(1);

  await revised.getByRole("button", { name: "Reject" }).click();
  await expect(revised).toHaveAttribute("data-status", "rejected");
  await expect(revised).toContainText("Nothing was changed");
  await expect(page.locator("[data-clip-id]")).toHaveCount(1);
  await expect(panel.getByRole("button", { name: "Undo agent changes" })).toBeDisabled();
  await expect(panel.getByTestId("agent-streaming")).toHaveCount(0);
});

test("turning Ask before editing off persists and the agent edits directly without plan tools", async ({ page }) => {
  await openProjectWithClip(page);
  const panel = page.getByTestId("agent-panel");
  await panel.getByLabel("Ask before editing").uncheck();
  await page.reload();
  await page.getByRole("tab", { name: "Agent" }).click();
  await expect(panel.getByLabel("Ask before editing")).not.toBeChecked();

  await page.evaluate(async () => {
    const url = "/src/app/agent/model-client.ts";
    const { ScriptedModelClient } = (await import(/* @vite-ignore */ url)) as typeof import("../src/app/agent/model-client");
    type Request = import("../src/app/agent/model-client").ModelRequest;
    const use = (id: string, name: string, input: unknown) => ({ type: "tool_use" as const, id, name, input });
    const model = new ScriptedModelClient([
      (request: Request) => {
        if (request.tools.some((t) => t.name === "propose_plan")) throw new Error("plan tool offered while Ask before editing is off");
        return { content: [use("c1", "insert_text", { text: "Hello", start: 0, duration: 2 })] };
      },
      { content: [{ type: "text", text: "Added the title." }] },
    ]);
    (globalThis as unknown as { __agentModel?: unknown }).__agentModel = model;
  });
  await panel.getByLabel("Message to the agent").fill("Add a Hello title");
  await panel.getByRole("button", { name: "Send" }).click();
  await expect(panel.getByTestId("agent-assistant-text").last()).toContainText("Added the title");
  await expect(panel.getByTestId("agent-plan")).toHaveCount(0);
  await expect(panel.getByRole("alert")).toHaveCount(0);
});
