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

test("the in-app agent edits the timeline, shows a rendered frame and one undo reverts the turn", async ({ page }) => {
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
  await panel.getByLabel("Anthropic API key").fill("");
  await expect(panel.getByTestId("agent-key-hint")).toBeVisible();
  await panel.getByLabel("Message to the agent").fill("hello");
  await panel.getByRole("button", { name: "Send" }).click();
  await expect(panel.getByRole("alert")).toContainText("API key");
});
