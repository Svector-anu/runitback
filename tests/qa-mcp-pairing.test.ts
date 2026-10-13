import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { BRIDGE_PROTOCOL_VERSION } from "#/platform/agent-bridge-protocol";
import { BridgeServer } from "../tools/mcp/bridge-server";
import { PairingManager } from "../tools/mcp/pairing";

const TOKEN = "t".repeat(48);
const GOOD = "http://localhost:5173";
let server: BridgeServer | null = null;
const sockets: WebSocket[] = [];

async function start(options: { allowedOrigins?: string[]; now?: () => number } = {}): Promise<number> {
  server = new BridgeServer({
    port: 0, token: TOKEN, helloTimeoutMs: 300, allowedOrigins: options.allowedOrigins,
    pairing: new PairingManager({ now: options.now, randomBelow: () => 123456 }),
  });
  return server.listen();
}

afterEach(async () => {
  for (const s of sockets.splice(0)) s.terminate();
  await server?.close();
  server = null;
});

/** Opens a socket, sends one frame and returns the parsed reply, or "blocked" when the upgrade is refused. */
function exchange(port: number, frame: unknown, origin: string | null = GOOD): Promise<Record<string, unknown> | "blocked"> {
  return new Promise((resolve) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}`, origin === null ? undefined : { origin });
    sockets.push(socket);
    socket.on("open", () => socket.send(typeof frame === "string" ? frame : JSON.stringify(frame)));
    socket.on("message", (d) => resolve(JSON.parse(d.toString()) as Record<string, unknown>));
    socket.on("unexpected-response", () => resolve("blocked"));
    socket.on("error", () => resolve("blocked"));
  });
}

const pair = (port: number, code: string, origin?: string | null): ReturnType<typeof exchange> => exchange(port, { type: "pair", code }, origin);

describe("QA: pairing against a real bridge", () => {
  it("a right code from an allowed origin yields the token exactly once", async () => {
    const port = await start();
    const { code } = server!.issuePairingCode();
    expect(await pair(port, code)).toEqual({ type: "paired", token: TOKEN });
    expect(await pair(port, code)).toMatchObject({ type: "pair_reject", reason: "no_code" });
  });

  it("the token it hands out completes the normal hello handshake", async () => {
    const port = await start();
    const reply = await pair(port, server!.issuePairingCode().code);
    const token = (reply as { token: string }).token;
    const ack = await exchange(port, { type: "hello", protocol: BRIDGE_PROTOCOL_VERSION, token, editorVersion: "qa", projectId: null });
    expect(ack).toMatchObject({ type: "hello_ack" });
  });

  it("never pairs a hostile origin, even with the right code, and its attempts do not burn the user's tries", async () => {
    const port = await start();
    const { code } = server!.issuePairingCode();
    for (const origin of ["https://evil.example", "http://localhost.evil.example", "http://127.0.0.1.evil.example", "null", "http://0.0.0.0"]) {
      expect(await pair(port, code, origin), origin).toBe("blocked");
    }
    expect(server!.pairing.failedAttempts).toBe(0);
    expect(await pair(port, code)).toMatchObject({ type: "paired" });
  });

  it("a client with no Origin header cannot pair and does not burn tries", async () => {
    const port = await start();
    const { code } = server!.issuePairingCode();
    expect(await exchange(port, { type: "pair", code }, null)).toMatchObject({ type: "pair_reject", reason: "origin_mismatch" });
    expect(server!.pairing.failedAttempts).toBe(0);
  });

  it("an allowlisted hosted origin can pair", async () => {
    const port = await start({ allowedOrigins: ["https://runitback.example"] });
    expect(await pair(port, server!.issuePairingCode().code, "https://runitback.example")).toMatchObject({ type: "paired" });
  });

  it("guessing: three wrong tries burn the code and the right one is then refused", async () => {
    const port = await start();
    const { code } = server!.issuePairingCode();
    const wrong = code === "000000" ? "000001" : "000000";
    const replies = [await pair(port, wrong), await pair(port, wrong), await pair(port, wrong)];
    expect(replies.map((r) => (r as { retriesLeft: number }).retriesLeft)).toEqual([2, 1, 0]);
    expect(await pair(port, code)).toMatchObject({ type: "pair_reject", reason: "no_code" });
    expect(server!.editor).toBeNull();
  });

  it("a wrong or malformed code never reveals the token", async () => {
    const port = await start();
    server!.issuePairingCode();
    for (const code of ["", "1", "12345a", "1".repeat(31), "'; drop", "123456 "]) {
      const reply = await pair(port, code);
      expect(JSON.stringify(reply), code).not.toContain(TOKEN);
    }
  });

  it("a code is dead after two minutes", async () => {
    let t = 0;
    const port = await start({ now: () => t });
    const { code } = server!.issuePairingCode();
    t = 120_001;
    expect(await pair(port, code)).toMatchObject({ type: "pair_reject" });
  });

  it("probe answers only with protocol and whether a code is live, never a token or code", async () => {
    const port = await start();
    expect(await exchange(port, { type: "probe" })).toEqual({ type: "bridge_info", protocol: BRIDGE_PROTOCOL_VERSION, pairing: false });
    server!.issuePairingCode();
    const reply = await exchange(port, { type: "probe" });
    expect(reply).toEqual({ type: "bridge_info", protocol: BRIDGE_PROTOCOL_VERSION, pairing: true });
    expect(JSON.stringify(reply)).not.toContain(TOKEN);
    expect(await exchange(port, { type: "probe" }, "https://evil.example")).toBe("blocked");
  });

  it("pair and probe frames after a hello are ignored and cannot be used to hijack the session", async () => {
    const port = await start();
    const { code } = server!.issuePairingCode();
    const reply = await new Promise<Record<string, unknown>[]>((resolve) => {
      const socket = new WebSocket(`ws://127.0.0.1:${port}`, { origin: GOOD });
      sockets.push(socket);
      const seen: Record<string, unknown>[] = [];
      socket.on("open", () => {
        socket.send(JSON.stringify({ type: "hello", protocol: BRIDGE_PROTOCOL_VERSION, token: TOKEN, editorVersion: "qa", projectId: null }));
        socket.send(JSON.stringify({ type: "pair", code }));
        socket.send(JSON.stringify({ type: "probe" }));
        setTimeout(() => resolve(seen), 250);
      });
      socket.on("message", (d) => seen.push(JSON.parse(d.toString()) as Record<string, unknown>));
    });
    expect(reply.some((m) => m.type === "paired" || m.type === "bridge_info")).toBe(false);
    expect(server!.pairing.hasActiveCode).toBe(true);
  });

  it("scanPorts falls through to the next free port when the first is taken", async () => {
    const first = new BridgeServer({ port: 0 });
    const base = await first.listen();
    const second = new BridgeServer({ port: base, scanPorts: true });
    try {
      expect(await second.listen()).toBeGreaterThan(base);
    } finally {
      await Promise.all([first.close(), second.close()]);
    }
  });

  it("an explicit port that is taken is an error, not a silent move", async () => {
    const first = new BridgeServer({ port: 0 });
    const base = await first.listen();
    const second = new BridgeServer({ port: base });
    try {
      await expect(second.listen()).rejects.toMatchObject({ code: "EADDRINUSE" });
    } finally {
      await first.close();
    }
  });
});
