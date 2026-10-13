import { expect, test, type Page } from "@playwright/test";
import { BridgeServer } from "../tools/mcp/bridge-server";
import { DEFAULT_BRIDGE_PORT } from "../src/platform/agent-bridge-protocol";

const SHOTS = "e2e/.artifacts/conn2";

test.use({ channel: process.env.PW_CHANNEL || undefined });

async function openAgent(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 1400 });
  await page.goto("/#/projects");
  await page.getByRole("button", { name: "Create your first project" }).click();
  await expect(page).toHaveURL(/#\/editor\//);
  await page.getByRole("tab", { name: "Agent" }).click();
}

async function startBridge(): Promise<BridgeServer> {
  const bridge = new BridgeServer({ port: DEFAULT_BRIDGE_PORT, scanPorts: true });
  await bridge.listen();
  return bridge;
}

test("pairing: the card finds the bridge by itself, a wrong code is rejected, the right code connects with no link", async ({ page }) => {
  const bridge = await startBridge();
  try {
    await openAgent(page);
    const card = page.getByTestId("claude-code-card");
    const status = card.getByTestId("claude-code-status");

    await expect(status).toContainText("enter the 6-digit code");
    await expect(card.getByRole("button", { name: "Pair" })).toBeDisabled();
    await page.screenshot({ path: `${SHOTS}/conn2-20-found.png` });

    const { code } = bridge.issuePairingCode();
    const wrong = code === "000000" ? "000001" : "000000";
    const input = card.getByLabel("6-digit pairing code");
    await input.fill(wrong);
    await card.getByRole("button", { name: "Pair" }).click();
    await expect(card.getByRole("alert")).toContainText("not the code");
    await expect(card.getByRole("alert")).toContainText("2 tries left");
    expect(bridge.editor).toBeNull();
    await page.screenshot({ path: `${SHOTS}/conn2-21-wrong-code.png` });

    await input.fill(code);
    await card.getByRole("button", { name: "Pair" }).click();
    await expect(status).toHaveText("Claude Code connected");
    await expect(page.getByTestId("agent-bridge-status")).toHaveAttribute("data-phase", "connected");
    expect(bridge.editor).not.toBeNull();
    expect(page.url()).not.toContain("token=");
    await page.screenshot({ path: `${SHOTS}/conn2-22-paired.png` });

    await page.getByTestId("agent-bridge-status").getByRole("button", { name: "Disconnect" }).click();
    await expect(page.getByTestId("agent-bridge-status")).toHaveAttribute("data-phase", "stopped");
    await expect(status).toContainText("enter the 6-digit code");
  } finally {
    await bridge.close();
  }
});

test("pairing: three wrong codes burn it, the right one is then refused until a new code is issued", async ({ page }) => {
  const bridge = await startBridge();
  try {
    await openAgent(page);
    const card = page.getByTestId("claude-code-card");
    await expect(card.getByTestId("claude-code-status")).toContainText("enter the 6-digit code");
    const { code } = bridge.issuePairingCode();
    const wrong = code === "000000" ? "000001" : "000000";
    const input = card.getByLabel("6-digit pairing code");
    for (let i = 0; i < 3; i++) {
      await input.fill(wrong);
      await card.getByRole("button", { name: "Pair" }).click();
      await expect(card.getByRole("alert")).toContainText("not the code");
    }
    await input.fill(code);
    await card.getByRole("button", { name: "Pair" }).click();
    await expect(card.getByRole("alert")).toContainText("no longer valid");
    expect(bridge.editor).toBeNull();
    await page.screenshot({ path: `${SHOTS}/conn2-23-burned.png` });

    const fresh = bridge.issuePairingCode().code;
    await input.fill(fresh);
    await card.getByRole("button", { name: "Pair" }).click();
    await expect(card.getByTestId("claude-code-status")).toHaveText("Claude Code connected");
  } finally {
    await bridge.close();
  }
});

test("no probing happens while the card is collapsed", async ({ page }) => {
  const bridge = await startBridge();
  let probes = 0;
  bridge.on("connect", () => undefined);
  try {
    await page.addInitScript(() => localStorage.setItem("runitback:agent-api-key", JSON.stringify("sk-ant-saved")));
    await openAgent(page);
    const card = page.getByTestId("claude-code-card");
    await expect(card).not.toHaveAttribute("open", "");
    page.on("websocket", () => { probes++; });
    await page.waitForTimeout(2500);
    expect(probes).toBe(0);
    await expect(card.getByTestId("claude-code-status")).toContainText("not connected");
    await card.locator("summary").first().click();
    await expect(card.getByTestId("claude-code-status")).toContainText("enter the 6-digit code");
    expect(probes).toBeGreaterThan(0);
  } finally {
    await bridge.close();
  }
});
