import { expect, test, type Page } from "@playwright/test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { BridgeServer } from "../tools/mcp/bridge-server";
import { createMcpServer } from "../tools/mcp/mcp-server";
import { importGenerated, makeWebm } from "./media";

const TOKEN = "e2e-token";

type Content = Array<{ type: string; text?: string; data?: string; mimeType?: string }>;

async function activateBridge(page: Page, port: number): Promise<void> {
  await page.evaluate(async ({ port: p, token }) => {
    const hash = location.hash.split("?")[0];
    location.hash = `${hash}?agent=${p}&token=${token}`;
    const url = "/src/app/agent-bridge-wiring.ts";
    const wiring = (await import(/* @vite-ignore */ url)) as typeof import("../src/app/agent-bridge-wiring");
    wiring.initAgentBridge();
  }, { port, token: TOKEN });
}

test("an MCP client drives the live editor through the bridge", async ({ page }) => {
  const bridge = new BridgeServer({ port: 0, token: TOKEN });
  const port = await bridge.listen();
  const mcpServer = createMcpServer({ bridge, connectUrl: () => `http://127.0.0.1:5199/#/projects?agent=${port}&token=${TOKEN}` });
  const mcp = new Client({ name: "e2e", version: "0" });
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  await Promise.all([mcpServer.connect(serverSide), mcp.connect(clientSide)]);

  try {
    await page.goto("/#/projects");
    await page.getByRole("button", { name: "Create your first project" }).click();
    await expect(page).toHaveURL(/#\/editor\//);
    await makeWebm(page, { seconds: 3, hue: 200, name: "bridge-a.webm", withAudio: true });
    await importGenerated(page);
    await page.getByRole("button", { name: "Add bridge-a.webm to timeline" }).click({ force: true });
    await expect(page.locator("[data-clip-id]")).toHaveCount(1);

    await activateBridge(page, port);
    const chip = page.getByTestId("agent-bridge-status");
    await expect(chip).toHaveAttribute("data-phase", "pending");
    await page.waitForTimeout(500);
    expect(bridge.editor).toBeNull();

    await chip.getByRole("button", { name: "Allow" }).click();
    await expect(chip).toHaveAttribute("data-phase", "connected");
    await expect(chip).toContainText("Agent: connected");
    expect(bridge.editor?.projectId).toBeTruthy();
    expect(page.url()).not.toContain(TOKEN);

    await expect.poll(async () => (await mcp.listTools()).tools.length).toBeGreaterThan(2);
    const names = (await mcp.listTools()).tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["editor_status", "render_frame", "export_project"]));

    if (names.includes("get_project")) {
      const project = await mcp.callTool({ name: "get_project", arguments: {} });
      expect(project.isError).toBeFalsy();
    }

    const frame = await mcp.callTool({ name: "render_frame", arguments: { time: 1 } });
    expect(frame.isError).toBeFalsy();
    const image = (frame.content as Content).find((c) => c.type === "image");
    expect(image?.mimeType).toBe("image/jpeg");
    const stats = await page.evaluate(async (base64) => {
      const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
      const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/jpeg" }));
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const ctx = canvas.getContext("2d") as OffscreenCanvasRenderingContext2D;
      ctx.drawImage(bitmap, 0, 0);
      const data = ctx.getImageData(0, 0, bitmap.width, bitmap.height).data;
      let lit = 0;
      for (let i = 0; i < data.length; i += 4) if ((data[i] ?? 0) + (data[i + 1] ?? 0) + (data[i + 2] ?? 0) > 60) lit++;
      return { width: bitmap.width, height: bitmap.height, litRatio: lit / (data.length / 4) };
    }, image?.data ?? "");
    expect(Math.max(stats.width, stats.height)).toBeLessThanOrEqual(1024);
    expect(stats.litRatio).toBeGreaterThan(0.5);

    const small = await mcp.callTool({ name: "render_frame", arguments: { time: 1, maxSize: 160 } });
    const smallImage = (small.content as Content).find((c) => c.type === "image");
    expect(smallImage?.data?.length).toBeLessThan(image?.data?.length ?? 0);

    const bad = await mcp.callTool({ name: "render_frame", arguments: { time: -1 } });
    expect(bad.isError).toBe(true);

    const exported = await mcp.callTool({ name: "export_project", arguments: { format: "webm", quality: "low" } });
    expect(exported.isError).toBeFalsy();
    const info = JSON.parse(((exported.content as Content)[1]?.text) ?? "{}") as { bytes: number; videoCodec: string; durationSeconds: number };
    expect(info.bytes).toBeGreaterThan(1000);
    expect(info.durationSeconds).toBeGreaterThan(2.5);
    const download = chip.getByRole("button", { name: /Download export/ });
    await expect(download).toBeVisible();
    const downloadPromise = page.waitForEvent("download");
    await download.click();
    expect((await downloadPromise).suggestedFilename()).toMatch(/\.webm$/);

    await chip.getByRole("button", { name: "Disconnect" }).click();
    await expect(chip).toHaveAttribute("data-phase", "stopped");
    await expect.poll(() => bridge.editor).toBeNull();
    const after = await mcp.callTool({ name: "render_frame", arguments: { time: 0 } });
    expect(after.isError).toBe(true);
  } finally {
    await mcp.close();
    await bridge.close();
  }
});

test("a wrong token is rejected and shown in the chip", async ({ page }) => {
  const bridge = new BridgeServer({ port: 0, token: "right" });
  const port = await bridge.listen();
  try {
    await page.goto("/#/projects");
    await activateBridge(page, port);
    const chip = page.getByTestId("agent-bridge-status");
    await chip.getByRole("button", { name: "Allow" }).click();
    await expect(chip).toHaveAttribute("data-phase", "rejected");
    await expect(chip).toContainText("Invalid token");
    expect(bridge.editor).toBeNull();
  } finally {
    await bridge.close();
  }
});

test("nothing starts without the agent parameter", async ({ page }) => {
  await page.goto("/#/projects");
  await page.evaluate(async () => {
    const url = "/src/app/agent-bridge-wiring.ts";
    const wiring = (await import(/* @vite-ignore */ url)) as typeof import("../src/app/agent-bridge-wiring");
    wiring.initAgentBridge();
  });
  await expect(page.getByTestId("agent-bridge-status")).toHaveCount(0);
});
