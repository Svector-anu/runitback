import { describe, expect, it } from "vitest";
import type { AgentTool, ToolContext, ToolResult } from "#/engine/agent";
import { AgentBridgeClient, type BridgeSocket } from "#/platform/agent-bridge";
import {
  BRIDGE_PROTOCOL_VERSION, MAX_MESSAGE_BYTES, ProtocolError, RpcClosedError, RpcCorrelator, RpcTimeoutError, backoffDelay, decodeMessage,
  encodeMessage, isAllowedOrigin, isLoopbackHostHeader, parseBrowserMessage, parseServerMessage, type Timers,
} from "#/platform/agent-bridge-protocol";

class ManualTimers implements Timers {
  now = 0;
  private next = 1;
  private readonly entries = new Map<number, { at: number; fn: () => void }>();
  set(fn: () => void, ms: number): unknown {
    const id = this.next++;
    this.entries.set(id, { at: this.now + ms, fn });
    return id;
  }
  clear(handle: unknown): void {
    this.entries.delete(handle as number);
  }
  get pendingCount(): number {
    return this.entries.size;
  }
  /** Fires the earliest timer and returns the virtual time it fired at. */
  fireNext(): number {
    const first = [...this.entries].sort((a, b) => a[1].at - b[1].at)[0];
    if (!first) throw new Error("no timers pending");
    this.entries.delete(first[0]);
    this.now = Math.max(this.now, first[1].at);
    first[1].fn();
    return this.now;
  }
  advance(ms: number): void {
    const end = this.now + ms;
    for (;;) {
      const first = [...this.entries].sort((a, b) => a[1].at - b[1].at)[0];
      if (!first || first[1].at > end) break;
      this.fireNext();
    }
    this.now = end;
  }
}

/** The page side of an in-memory socket pair; the test plays the server through `server*` helpers. */
class FakeSocket implements BridgeSocket {
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  readonly sent: Array<Record<string, unknown>> = [];
  closedWith: { code?: number; reason?: string } | null = null;

  send(data: string): void {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }
  close(code?: number, reason?: string): void {
    this.closedWith = { code, reason };
    this.onclose?.({ code: code ?? 1005, reason: reason ?? "" });
  }
  serverOpen(): void {
    this.onopen?.();
  }
  serverSend(message: unknown): void {
    this.onmessage?.({ data: typeof message === "string" ? message : JSON.stringify(message) });
  }
  serverDrop(code = 1006): void {
    this.onclose?.({ code, reason: "" });
  }
  last(type: string): Record<string, unknown> | undefined {
    return [...this.sent].reverse().find((m) => m.type === type);
  }
}

const tool = (name: string, run: AgentTool["run"], readOnly = true): AgentTool => ({
  name, description: `${name} tool`, inputSchema: { type: "object", properties: { x: { type: "number" } } }, readOnly, run,
});

function setup(tools: AgentTool[] = [], opts: { random?: () => number } = {}) {
  const timers = new ManualTimers();
  const sockets: FakeSocket[] = [];
  const registry = new Map(tools.map((t) => [t.name, t]));
  const client = new AgentBridgeClient({
    url: "ws://127.0.0.1:7777", token: "secret", tools: () => registry,
    context: () => ({ editor: {} as ToolContext["editor"], nowMs: () => 0 }),
    hello: () => ({ editorVersion: "9.9.9", projectId: "p1" }),
    createSocket: () => { const s = new FakeSocket(); sockets.push(s); return s; },
    timers, random: opts.random ?? (() => 0), baseDelayMs: 100, maxDelayMs: 1000,
  });
  const connect = (): FakeSocket => {
    client.start();
    const socket = sockets[sockets.length - 1] as FakeSocket;
    socket.serverOpen();
    socket.serverSend({ type: "hello_ack", protocol: BRIDGE_PROTOCOL_VERSION, sessionId: "s1" });
    return socket;
  };
  return { client, timers, sockets, connect };
}

const flush = async (): Promise<void> => { for (let i = 0; i < 5; i++) await Promise.resolve(); };

describe("protocol framing", () => {
  it("round-trips every message type", () => {
    const hello = { type: "hello", protocol: 1, token: "t", editorVersion: "1", projectId: null } as const;
    expect(parseBrowserMessage(encodeMessage(hello))).toEqual(hello);
    const result = { type: "result", id: "r1", result: { ok: true, summary: "done" } } as const;
    expect(parseBrowserMessage(encodeMessage(result))).toEqual(result);
    const call = { type: "call_tool", id: "r2", name: "x", input: { a: 1 } } as const;
    expect(parseServerMessage(encodeMessage(call))).toEqual(call);
    expect(parseServerMessage(encodeMessage({ type: "ping", id: "r3" }))).toEqual({ type: "ping", id: "r3" });
  });

  it.each([
    ["not json", "{nope"],
    ["array", "[]"],
    ["missing type", "{}"],
    ["unknown type", '{"type":"explode"}'],
  ])("rejects %s", (_name, raw) => {
    expect(() => parseBrowserMessage(raw)).toThrow(ProtocolError);
    expect(() => parseServerMessage(raw)).toThrow(ProtocolError);
  });

  it("rejects structurally wrong messages", () => {
    expect(() => parseBrowserMessage('{"type":"hello","protocol":"1"}')).toThrow(/Malformed hello/);
    expect(() => parseBrowserMessage('{"type":"result","id":"a","result":{}}')).toThrow(/Malformed result/);
    expect(() => parseServerMessage('{"type":"call_tool","id":"a"}')).toThrow(/Malformed call_tool/);
  });

  it("enforces the size cap on both encode and decode", () => {
    const huge = "x".repeat(MAX_MESSAGE_BYTES + 1);
    expect(() => decodeMessage(huge)).toThrow(/size cap/);
    expect(() => encodeMessage({ type: "result", id: "a", result: { ok: true, summary: huge } })).toThrow(/size cap/);
  });

  it("carries multi-megabyte image payloads intact", () => {
    const base64 = "A".repeat(8 * 1024 * 1024);
    const wire = encodeMessage({ type: "result", id: "big", result: { ok: true, summary: "img", images: [{ mediaType: "image/jpeg", base64 }] } });
    const back = parseBrowserMessage(wire);
    expect(back.type === "result" && back.result.ok && back.result.images?.[0]?.base64.length).toBe(base64.length);
  });
});

describe("origin and host checks", () => {
  it("accepts loopback and absent origins only", () => {
    expect(isAllowedOrigin(undefined)).toBe(true);
    expect(isAllowedOrigin("http://localhost:5173")).toBe(true);
    expect(isAllowedOrigin("http://127.0.0.1:5199")).toBe(true);
    expect(isAllowedOrigin("http://[::1]:3000")).toBe(true);
    expect(isAllowedOrigin("https://evil.example")).toBe(false);
    expect(isAllowedOrigin("https://localhost.evil.example")).toBe(false);
    expect(isAllowedOrigin("null")).toBe(false);
    expect(isAllowedOrigin("https://editor.example", ["https://editor.example"])).toBe(true);
  });

  it("validates the Host header against DNS rebinding", () => {
    expect(isLoopbackHostHeader("127.0.0.1:7777")).toBe(true);
    expect(isLoopbackHostHeader("localhost:7777")).toBe(true);
    expect(isLoopbackHostHeader("[::1]:7777")).toBe(true);
    expect(isLoopbackHostHeader("attacker.example:7777")).toBe(false);
    expect(isLoopbackHostHeader(undefined)).toBe(false);
  });
});

describe("RpcCorrelator", () => {
  it("resolves the matching request out of order", async () => {
    const rpc = new RpcCorrelator<string>(new ManualTimers());
    const ids: string[] = [];
    const a = rpc.request({ timeoutMs: 10, send: (id) => ids.push(id) });
    const b = rpc.request({ timeoutMs: 10, send: (id) => ids.push(id) });
    expect(rpc.settle(ids[1] as string, "B")).toBe(true);
    expect(rpc.settle(ids[0] as string, "A")).toBe(true);
    await expect(a).resolves.toBe("A");
    await expect(b).resolves.toBe("B");
    expect(rpc.size).toBe(0);
  });

  it("times out, then ignores the late reply", async () => {
    const timers = new ManualTimers();
    const rpc = new RpcCorrelator<string>(timers);
    let id = "";
    const p = rpc.request({ timeoutMs: 50, send: (i) => { id = i; } });
    const expectation = expect(p).rejects.toBeInstanceOf(RpcTimeoutError);
    timers.advance(50);
    await expectation;
    expect(rpc.settle(id, "late")).toBe(false);
  });

  it("rejects everything pending when the connection closes", async () => {
    const rpc = new RpcCorrelator<string>(new ManualTimers());
    const p = rpc.request({ timeoutMs: 1000, send: () => undefined });
    rpc.rejectAll("gone");
    await expect(p).rejects.toBeInstanceOf(RpcClosedError);
  });

  it("surfaces a send failure and leaves nothing pending", async () => {
    const timers = new ManualTimers();
    const rpc = new RpcCorrelator<string>(timers);
    await expect(rpc.request({ timeoutMs: 1000, send: () => { throw new Error("socket closed"); } })).rejects.toThrow("socket closed");
    expect(rpc.size).toBe(0);
    expect(timers.pendingCount).toBe(0);
  });
});

describe("backoffDelay", () => {
  it("grows exponentially up to the cap", () => {
    const d = (attempt: number): number => backoffDelay({ attempt, baseMs: 100, maxMs: 1000, random: () => 0 });
    expect([d(0), d(1), d(2), d(3), d(4), d(10)]).toEqual([100, 200, 400, 800, 1000, 1000]);
  });
  it("never exceeds the cap with jitter", () => {
    expect(backoffDelay({ attempt: 10, baseMs: 100, maxMs: 1000, random: () => 0.999 })).toBeLessThanOrEqual(1000);
  });
});

describe("AgentBridgeClient", () => {
  it("sends hello with token, protocol, version and project on open", () => {
    const { client, sockets } = setup();
    client.start();
    sockets[0]?.serverOpen();
    expect(sockets[0]?.last("hello")).toEqual({ type: "hello", protocol: BRIDGE_PROTOCOL_VERSION, token: "secret", editorVersion: "9.9.9", projectId: "p1" });
    expect(client.getStatus().state).toBe("connecting");
  });

  it("is connected only after hello_ack", () => {
    const { client, connect } = setup();
    connect();
    expect(client.getStatus()).toMatchObject({ state: "connected", sessionId: "s1", attempt: 0 });
  });

  it("answers list_tools with descriptors", () => {
    const { connect } = setup([tool("a", () => ({ ok: true, summary: "" }), false)]);
    const socket = connect();
    socket.serverSend({ type: "list_tools", id: "q1" });
    expect(socket.last("tools")).toEqual({
      type: "tools", id: "q1",
      tools: [{ name: "a", description: "a tool", inputSchema: { type: "object", properties: { x: { type: "number" } } }, readOnly: false }],
    });
  });

  it("answers ping with the same id", () => {
    const { connect } = setup();
    const socket = connect();
    socket.serverSend({ type: "ping", id: "p9" });
    expect(socket.last("pong")).toEqual({ type: "pong", id: "p9" });
  });

  it("correlates call results to their ids and runs calls one at a time", async () => {
    const order: string[] = [];
    let releaseSlow: (r: ToolResult) => void = () => undefined;
    const slow = tool("slow", () => { order.push("slow:start"); return new Promise<ToolResult>((r) => { releaseSlow = r; }); });
    const fast = tool("fast", (input) => { order.push("fast:start"); return { ok: true, summary: `fast ${JSON.stringify(input)}` }; });
    const { connect } = setup([slow, fast]);
    const socket = connect();
    socket.serverSend({ type: "call_tool", id: "c1", name: "slow", input: {} });
    socket.serverSend({ type: "call_tool", id: "c2", name: "fast", input: { x: 1 } });
    await flush();
    expect(order).toEqual(["slow:start"]);
    releaseSlow({ ok: true, summary: "slow done" });
    await flush();
    expect(order).toEqual(["slow:start", "fast:start"]);
    const results = socket.sent.filter((m) => m.type === "result");
    expect(results).toEqual([
      { type: "result", id: "c1", result: { ok: true, summary: "slow done" } },
      { type: "result", id: "c2", result: { ok: true, summary: 'fast {"x":1}' } },
    ]);
  });

  it("reports unknown tools and thrown errors as failed results", async () => {
    const { connect } = setup([tool("boom", () => { throw new Error("kaput"); })]);
    const socket = connect();
    socket.serverSend({ type: "call_tool", id: "c1", name: "nope", input: {} });
    socket.serverSend({ type: "call_tool", id: "c2", name: "boom", input: {} });
    await flush();
    const [unknown, thrown] = socket.sent.filter((m) => m.type === "result") as Array<{ id: string; result: { ok: boolean; error: string } }>;
    expect(unknown).toMatchObject({ id: "c1", result: { ok: false, error: "Unknown tool 'nope'" } });
    expect(thrown?.result).toMatchObject({ ok: false });
    expect(thrown?.result.error).toContain("kaput");
  });

  it("sends a large image result back in one frame", async () => {
    const base64 = "B".repeat(6 * 1024 * 1024);
    const { connect } = setup([tool("img", () => ({ ok: true, summary: "i", images: [{ mediaType: "image/jpeg", base64 }] }))]);
    const socket = connect();
    socket.serverSend({ type: "call_tool", id: "c1", name: "img", input: {} });
    await flush();
    const result = socket.last("result") as { result: { images: Array<{ base64: string }> } };
    expect(result.result.images[0]?.base64.length).toBe(base64.length);
  });

  it("downgrades an unsendable result to an error instead of dropping the call", async () => {
    const base64 = "C".repeat(MAX_MESSAGE_BYTES + 10);
    const { connect } = setup([tool("img", () => ({ ok: true, summary: "i", images: [{ mediaType: "image/jpeg", base64 }] }))]);
    const socket = connect();
    socket.serverSend({ type: "call_tool", id: "c1", name: "img", input: {} });
    await flush();
    expect(socket.last("result")).toMatchObject({ id: "c1", result: { ok: false } });
  });

  it("ignores garbage and non-text frames", () => {
    const { client, connect } = setup();
    const socket = connect();
    socket.serverSend("{broken");
    socket.serverSend(new ArrayBuffer(4) as unknown as string);
    socket.onmessage?.({ data: new ArrayBuffer(4) });
    expect(client.getStatus().state).toBe("connected");
  });

  it("reconnects with growing backoff and resets after a successful handshake", () => {
    const { client, timers, sockets, connect } = setup();
    const first = connect();
    first.serverDrop();
    expect(client.getStatus()).toMatchObject({ state: "waiting", attempt: 1 });
    expect(timers.pendingCount).toBe(1);
    const t1 = timers.fireNext();
    expect(t1).toBe(100);
    expect(sockets).toHaveLength(2);
    sockets[1]?.serverDrop();
    expect(timers.fireNext()).toBe(100 + 200);
    sockets[2]?.serverDrop();
    expect(timers.fireNext()).toBe(300 + 400);
    expect(client.getStatus().attempt).toBe(3);
    sockets[3]?.serverOpen();
    sockets[3]?.serverSend({ type: "hello_ack", protocol: 1, sessionId: "s2" });
    expect(client.getStatus()).toMatchObject({ state: "connected", attempt: 0, sessionId: "s2" });
    sockets[3]?.serverDrop();
    expect(timers.fireNext()).toBe(700 + 100);
  });

  it("does not reconnect after the server rejects the token", () => {
    const { client, timers, sockets } = setup();
    client.start();
    sockets[0]?.serverOpen();
    sockets[0]?.serverSend({ type: "reject", reason: "Invalid token" });
    sockets[0]?.serverDrop(4401);
    expect(client.getStatus()).toMatchObject({ state: "rejected", reason: "Invalid token" });
    expect(timers.pendingCount).toBe(0);
  });

  it("treats close code 4401 as a rejection even without a reject frame", () => {
    const { client, timers, sockets } = setup();
    client.start();
    sockets[0]?.serverOpen();
    sockets[0]?.serverDrop(4401);
    expect(client.getStatus().state).toBe("rejected");
    expect(timers.pendingCount).toBe(0);
  });

  it("closes a connection whose handshake never completes, then retries", () => {
    const { client, timers, sockets } = setup();
    client.start();
    sockets[0]?.serverOpen();
    timers.advance(5000);
    expect(sockets[0]?.closedWith?.code).toBe(4408);
    expect(client.getStatus().state).toBe("waiting");
  });

  it("stop() closes cleanly and never reconnects", () => {
    const { client, timers, sockets, connect } = setup();
    const socket = connect();
    client.stop();
    expect(socket.closedWith).toEqual({ code: 1000, reason: "client closing" });
    expect(client.getStatus().state).toBe("stopped");
    expect(timers.pendingCount).toBe(0);
    expect(sockets).toHaveLength(1);
  });

  it("stop() while waiting to reconnect cancels the retry", () => {
    const { client, timers, sockets, connect } = setup();
    connect().serverDrop();
    client.stop();
    expect(timers.pendingCount).toBe(0);
    expect(sockets).toHaveLength(1);
  });

  it("can be started again after stop", () => {
    const { client, sockets, connect } = setup();
    connect();
    client.stop();
    connect();
    expect(sockets).toHaveLength(2);
    expect(client.getStatus().state).toBe("connected");
  });
});
