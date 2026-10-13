import { expect, test, type Page } from "@playwright/test";
import { BridgeServer } from "../tools/mcp/bridge-server";

const SHOTS = "e2e/.artifacts/conn2";
const KEY_PREF = "runitback:agent-api-key";
const TOKEN = "conn-token";

test.use({ channel: process.env.PW_CHANNEL || undefined });

async function openAgent(page: Page, options: { key?: string; width?: number; height?: number } = {}): Promise<void> {
  await page.setViewportSize({ width: options.width ?? 1440, height: options.height ?? 900 });
  if (options.key) await page.addInitScript(([k, v]) => localStorage.setItem(k as string, JSON.stringify(v)), [KEY_PREF, options.key]);
  await page.goto("/#/projects");
  await page.getByRole("button", { name: "Create your first project" }).click();
  await expect(page).toHaveURL(/#\/editor\//);
  await page.getByRole("tab", { name: "Agent" }).click();
}

test("Claude Code card is short: one sentence, three steps, one command, tools and extras collapsed", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await openAgent(page, { height: 1400 });
  const card = page.getByTestId("claude-code-card");
  await expect(card).toHaveAttribute("open", "");
  await expect(card.getByText("Use your Claude subscription (Claude Code)")).toBeVisible();
  await expect(card.locator(".cc-card__body > p")).toHaveCount(1);
  await expect(card.locator(".cc-steps > li")).toHaveCount(3);

  const command = await card.getByTestId("claude-code-command").innerText();
  expect(command).toBe('git clone https://github.com/Svector-anu/runitback.git runitback && cd runitback && pnpm install && claude mcp add runitback -- pnpm --dir "$PWD" exec tsx tools/mcp/server.ts');
  await expect(card.getByRole("button", { name: "Copy command" })).toHaveCount(1);
  await card.getByRole("button", { name: "Copy command" }).click();
  await expect(card.getByText("Copied")).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(command);

  await expect(card.getByTestId("claude-code-status")).toHaveAttribute("role", "status");
  await expect(card.getByText("render_frame")).toBeHidden();
  await expect(card.getByText("Anthropic does not let other apps use a Claude subscription login")).toBeHidden();
  await expect(card.getByLabel("Link from Claude Code")).toBeHidden();
  await expect(card).not.toContainText("Local Network");
  await expect(card).not.toContainText("local network");
  await page.screenshot({ path: `${SHOTS}/conn2-01-short-card.png` });

  await card.getByText("What can Claude Code do?").click();
  await expect(card.getByText("render_frame")).toBeVisible();
  await card.getByText("Why not sign in with Claude?").click();
  await expect(card.getByText("Anthropic does not let other apps use a Claude subscription login")).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/conn2-02-extras-open.png` });

  const summary = card.locator("summary").first();
  await summary.focus();
  await page.keyboard.press("Enter");
  await expect(card).not.toHaveAttribute("open", "");
  await expect(card.getByTestId("claude-code-status")).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/conn2-03-collapsed.png` });
});

test("with a key already saved the card is collapsed but its status is still visible", async ({ page }) => {
  await openAgent(page, { key: "sk-ant-saved" });
  const card = page.getByTestId("claude-code-card");
  await expect(card).not.toHaveAttribute("open", "");
  await expect(card.getByTestId("claude-code-status")).toBeVisible();
  await expect(card.getByRole("button", { name: "Copy command" })).toBeHidden();
  await page.screenshot({ path: `${SHOTS}/conn2-04-key-saved-collapsed.png` });
});

test("advanced fallback: the status chip follows the real bridge for a pasted link, Allow, connected, disconnect, bad links", async ({ page }) => {
  const bridge = new BridgeServer({ port: 0, token: TOKEN });
  const port = await bridge.listen();
  try {
    await openAgent(page);
    const card = page.getByTestId("claude-code-card");
    const status = card.getByTestId("claude-code-status");
    await card.getByText("Advanced: paste a link instead").click();
    const input = card.getByLabel("Link from Claude Code");

    await input.fill("not a link");
    await card.getByRole("button", { name: "Connect" }).click();
    await expect(card.getByRole("alert")).toContainText("not a link");
    await input.fill("http://localhost:5173/#/projects");
    await card.getByRole("button", { name: "Connect" }).click();
    await expect(card.getByRole("alert")).toContainText("no agent parameter");
    await input.fill(`http://localhost:5173/#/projects?agent=${port}`);
    await card.getByRole("button", { name: "Connect" }).click();
    await expect(card.getByRole("alert")).toContainText("missing its token");

    await input.fill(`http://localhost:5173/#/projects?agent=${port}&token=${TOKEN}`);
    await card.getByRole("button", { name: "Connect" }).click();
    await expect(status).toHaveAttribute("data-tone", "waiting");
    await expect(status).toContainText("click Allow");
    await page.waitForTimeout(400);
    expect(bridge.editor).toBeNull();
    await page.screenshot({ path: `${SHOTS}/conn2-14-pending.png` });

    await card.getByRole("button", { name: "Allow Claude Code to edit" }).click();
    await expect(status).toHaveText("Claude Code connected");
    await expect(page.getByTestId("agent-bridge-status")).toHaveAttribute("data-phase", "connected");
    expect(bridge.editor).not.toBeNull();
    await page.screenshot({ path: `${SHOTS}/conn2-15-connected.png` });

    await page.getByTestId("agent-bridge-status").getByRole("button", { name: "Disconnect" }).click();
    await expect(status).toContainText("disconnected");
  } finally {
    await bridge.close();
  }
});

test("a wrong token is shown as rejected, not connected", async ({ page }) => {
  const bridge = new BridgeServer({ port: 0, token: TOKEN });
  const port = await bridge.listen();
  try {
    await openAgent(page);
    const card = page.getByTestId("claude-code-card");
    await card.getByText("Advanced: paste a link instead").click();
    await card.getByLabel("Link from Claude Code").fill(`http://localhost:5173/#/projects?agent=${port}&token=wrong`);
    await card.getByRole("button", { name: "Connect" }).click();
    await card.getByRole("button", { name: "Allow Claude Code to edit" }).click();
    await expect(card.getByTestId("claude-code-status")).toHaveAttribute("data-tone", "error");
  } finally {
    await bridge.close();
  }
});

async function stubAnthropic(page: Page, respond: (key: string) => { status: number; body: unknown } | "abort"): Promise<string[]> {
  const seen: string[] = [];
  await page.route("https://api.anthropic.com/v1/messages", async (route) => {
    const request = route.request();
    seen.push(`${request.method()} ${request.postData() ?? ""}`);
    if (request.method() === "OPTIONS") {
      await route.fulfill({ status: 204, headers: { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "POST" } });
      return;
    }
    const outcome = respond(request.headers()["x-api-key"] ?? "");
    if (outcome === "abort") { await route.abort("failed"); return; }
    await route.fulfill({ status: outcome.status, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: JSON.stringify(outcome.body) });
  });
  return seen;
}

test("Get an API key opens the console safely; Test key reports success and each failure; the key never reaches the console log", async ({ page }) => {
  const logs: string[] = [];
  page.on("console", (m) => logs.push(m.text()));
  const SECRET = "sk-ant-conn-secret-0001";
  let mode: "ok" | "401" | "429" | "net" = "ok";
  const seen = await stubAnthropic(page, (key) => {
    expect(key).toBe(SECRET);
    if (mode === "ok") return { status: 200, body: { id: "msg_1", type: "message", role: "assistant", content: [], usage: {} } };
    if (mode === "401") return { status: 401, body: { type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } } };
    if (mode === "429") return { status: 429, body: { type: "error", error: { type: "rate_limit_error", message: "slow down" } } };
    return "abort";
  });
  await openAgent(page);
  const panel = page.getByTestId("agent-panel");

  const get = panel.getByRole("link", { name: "Get an API key" });
  await expect(get).toHaveAttribute("href", "https://console.anthropic.com/settings/keys");
  await expect(get).toHaveAttribute("target", "_blank");
  await expect(get).toHaveAttribute("rel", /noopener/);
  await expect(panel.getByRole("button", { name: "Test key" })).toHaveCount(0);
  await expect(panel.getByRole("button", { name: "Forget key" })).toHaveCount(0);
  await panel.getByText("Privacy and cost").click();
  await expect(panel.getByText(/You pay Anthropic directly/)).toBeVisible();
  await expect(panel.getByText(/This is an API key, not a Claude subscription login/)).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/conn2-16-key-area-empty.png` });

  await panel.getByLabel("Anthropic API key").fill(SECRET);
  const result = panel.getByTestId("agent-key-result");
  await panel.getByRole("button", { name: "Test key" }).click();
  await expect(result).toContainText("Key works");
  expect(seen).toHaveLength(1);
  expect(seen[0]).toContain('"max_tokens":1');
  await page.screenshot({ path: `${SHOTS}/conn2-17-key-ok.png` });

  mode = "401";
  await panel.getByRole("button", { name: "Test key" }).click();
  await expect(result).toContainText("rejected this key (401)");
  await page.screenshot({ path: `${SHOTS}/conn2-18-key-401.png` });
  mode = "429";
  await panel.getByRole("button", { name: "Test key" }).click();
  await expect(result).toContainText("rate limited");
  mode = "net";
  await panel.getByRole("button", { name: "Test key" }).click();
  await expect(result).toContainText("Could not reach Anthropic");

  expect(logs.join("\n")).not.toContain(SECRET);
  await expect(panel.getByTestId("agent-bridge-status")).toHaveCount(0);

  await panel.getByRole("button", { name: "Forget key" }).click();
  await expect(panel.getByLabel("Anthropic API key")).toHaveValue("");
  expect(await page.evaluate((k) => localStorage.getItem(k), KEY_PREF)).toBe('""');
  await expect(result).toBeEmpty();
});

test("narrow panel: the card does not overflow horizontally", async ({ page }) => {
  await openAgent(page, { width: 1100, height: 640 });
  const overflow = await page.getByTestId("agent-panel").evaluate((el) => el.scrollWidth - el.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  await page.screenshot({ path: `${SHOTS}/conn2-19-short-screen.png` });
});
