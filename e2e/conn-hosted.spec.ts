import { expect, test, type Page } from "@playwright/test";
import { BridgeServer } from "../tools/mcp/bridge-server";

/**
 * Behaviour of the loopback bridge from an https page, which is what the hosted site is. The https origin is simulated by
 * fulfilling a document on a fake host, so no network or deployment is involved. Needs real Chrome (PW_CHANNEL=chrome):
 * the `local-network-access` permission is Chrome's Local Network Access gate and is unknown to the bundled Chromium.
 */
const HOSTED = "https://runitback.example";
const TOKEN = "hosted-token";

test.skip(process.env.PW_CHANNEL !== "chrome", "needs real Chrome for the Local Network Access permission");
test.use({ channel: process.env.PW_CHANNEL || undefined });

async function handshake(page: Page, port: number): Promise<string> {
  await page.route(`${HOSTED}/**`, (route) => route.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html><title>hosted</title>" }));
  await page.goto(`${HOSTED}/`);
  return page.evaluate(({ p, token }) => new Promise<string>((resolve) => {
    const socket = new WebSocket(`ws://127.0.0.1:${p}`);
    socket.onopen = () => socket.send(JSON.stringify({ type: "hello", protocol: 1, token, editorVersion: "0", projectId: null }));
    socket.onmessage = (event) => { resolve(JSON.parse(String(event.data)).type as string); socket.close(); };
    socket.onerror = () => resolve("blocked");
  }), { p: port, token: TOKEN });
}

test("https origin: closed by default, open only when allowlisted AND Chrome's local network permission is granted", async ({ browser }) => {
  const closed = new BridgeServer({ port: 0, token: TOKEN });
  const allowed = new BridgeServer({ port: 0, token: TOKEN, allowedOrigins: [HOSTED] });
  const [closedPort, allowedPort] = [await closed.listen(), await allowed.listen()];
  try {
    const noPermission = await (await browser.newContext()).newPage();
    expect(await handshake(noPermission, allowedPort), "no Local Network Access permission").toBe("blocked");

    const granted = await browser.newContext();
    await granted.grantPermissions(["local-network-access"], { origin: HOSTED });
    expect(await handshake(await granted.newPage(), closedPort), "origin not allowlisted").toBe("blocked");
    expect(await handshake(await granted.newPage(), allowedPort), "allowlisted + permission").toBe("hello_ack");
  } finally {
    await Promise.all([closed.close(), allowed.close()]);
  }
});
