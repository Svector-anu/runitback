import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import type { BridgeSocket } from "#/platform/agent-bridge";
import { pairWithBridge, probeBridges } from "#/platform/agent-pairing";
import { BridgeServer } from "../tools/mcp/bridge-server";

const createSocket = (url: string): BridgeSocket => new WebSocket(url, { origin: "http://localhost:5173" }) as unknown as BridgeSocket;
let server: BridgeServer | null = null;

afterEach(async () => {
  await server?.close();
  server = null;
});

describe("page-side pairing client", () => {
  it("finds a live bridge, skips closed ports and reports whether a code is live", async () => {
    server = new BridgeServer({ port: 0 });
    const port = await server.listen();
    expect(await probeBridges({ createSocket, ports: [port + 1, port], timeoutMs: 500 })).toEqual([{ port, pairing: false }]);
    server.issuePairingCode();
    expect(await probeBridges({ createSocket, ports: [port], timeoutMs: 500 })).toEqual([{ port, pairing: true }]);
  });

  it("stops scanning when cancelled", async () => {
    expect(await probeBridges({ createSocket, ports: [1, 2, 3], isCancelled: () => true })).toEqual([]);
  });

  it("exchanges a code for the token and reports wrong codes with tries left", async () => {
    server = new BridgeServer({ port: 0, token: "tok" });
    const port = await server.listen();
    const { code } = server.issuePairingCode();
    const wrong = code === "000000" ? "000001" : "000000";
    expect(await pairWithBridge({ createSocket, port, code: wrong })).toEqual({ ok: false, reason: "wrong_code", retriesLeft: 2 });
    expect(await pairWithBridge({ createSocket, port, code })).toEqual({ ok: true, token: "tok" });
  });

  it("reports an unreachable server", async () => {
    expect(await pairWithBridge({ createSocket, port: 1, code: "123456", timeoutMs: 500 })).toMatchObject({ ok: false, reason: "unreachable" });
  });
});
