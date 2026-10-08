import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import WebSocket from "ws";
import type { ToolResult } from "#/engine/agent";
import { BRIDGE_PROTOCOL_VERSION, MAX_MESSAGE_BYTES, type ToolDescriptor } from "#/platform/agent-bridge-protocol";
import { BridgeServer } from "../tools/mcp/bridge-server";
import { createMcpServer } from "../tools/mcp/mcp-server";

const TOKEN = "test-token";
const DESCRIPTORS: ToolDescriptor[] = [
  { name: "get_project", description: "Read the project", inputSchema: { type: "object", properties: {} }, readOnly: true },
  { name: "render_frame", description: "Render", inputSchema: { type: "object", properties: { time: { type: "number" } }, required: ["time"] }, readOnly: true },
  { name: "add_clip", description: "Add", inputSchema: { type: "object", properties: { id: { type: "string" } } }, readOnly: false },
];

type Handler = (name: string, input: unknown) => ToolResult | Promise<ToolResult> | "never";

/** Stands in for the editor tab: a ws client that speaks the browser side of the protocol. */
class FakeBrowser {
  readonly ws: WebSocket;
  readonly calls: Array<{ name: string; input: unknown }> = [];
  handler: Handler = () => ({ ok: true, summary: "ok" });
  tools: ToolDescriptor[] = DESCRIPTORS;
  closeCode: number | null = null;
  ackReceived: Promise<void>;
  rejectReason: Promise<string>;

  constructor(url: string, opts: { token?: string; origin?: string; protocol?: number; hello?: boolean } = {}) {
    this.ws = new WebSocket(url, opts.origin ? { origin: opts.origin } : undefined);
    let ack: () => void = () => undefined;
    let rej: (r: string) => void = () => undefined;
    this.ackReceived = new Promise<void>((r) => { ack = r; });
    this.rejectReason = new Promise<string>((r) => { rej = r; });
    this.ws.on("open", () => {
      if (opts.hello === false) return;
      this.ws.send(JSON.stringify({ type: "hello", protocol: opts.protocol ?? BRIDGE_PROTOCOL_VERSION, token: opts.token ?? TOKEN, editorVersion: "t", projectId: "proj-1" }));
    });
    this.ws.on("close", (code) => { this.closeCode = code; });
    this.ws.on("error", () => undefined);
    this.ws.on("message", async (raw) => {
      const m = JSON.parse(raw.toString()) as { type: string; id?: string; name?: string; input?: unknown; reason?: string };
      if (m.type === "hello_ack") ack();
      else if (m.type === "reject") rej(m.reason ?? "");
      else if (m.type === "list_tools") this.ws.send(JSON.stringify({ type: "tools", id: m.id, tools: this.tools }));
      else if (m.type === "ping") this.ws.send(JSON.stringify({ type: "pong", id: m.id }));
      else if (m.type === "call_tool") {
        this.calls.push({ name: m.name as string, input: m.input });
        const out = this.handler(m.name as string, m.input);
        if (out === "never") return;
        this.ws.send(JSON.stringify({ type: "result", id: m.id, result: await out }));
      }
    });
  }

  closed(): Promise<number> {
    return new Promise((resolve) => {
      if (this.closeCode !== null) resolve(this.closeCode);
      else this.ws.on("close", (code) => resolve(code));
    });
  }
  close(): void {
    this.ws.close();
  }
}

async function until(check: () => boolean, label: string): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > 3000) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe("MCP bridge server", () => {
  let bridge: BridgeServer;
  let url: string;
  let client: Client;
  let browsers: FakeBrowser[];
  const logs: string[] = [];
  const text = (res: Awaited<ReturnType<Client["callTool"]>>): string =>
    (res.content as Array<{ type: string; text?: string }>).filter((c) => c.type === "text").map((c) => c.text).join("\n");

  const start = async (extra: Partial<ConstructorParameters<typeof BridgeServer>[0]> = {}): Promise<void> => {
    bridge = new BridgeServer({ port: 0, token: TOKEN, log: (l) => logs.push(l), ...extra });
    const port = await bridge.listen();
    url = `ws://127.0.0.1:${port}`;
    const server = createMcpServer({ bridge, connectUrl: () => `http://localhost:5173/#/projects?agent=${port}&token=${TOKEN}` });
    client = new Client({ name: "test", version: "0" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(a), client.connect(b)]);
  };
  const connectBrowser = async (opts: ConstructorParameters<typeof FakeBrowser>[1] = {}): Promise<FakeBrowser> => {
    const b = new FakeBrowser(url, opts);
    browsers.push(b);
    await b.ackReceived;
    await until(() => bridge.toolList.length > 0, "tool list");
    return b;
  };

  beforeEach(() => { browsers = []; logs.length = 0; });
  afterEach(async () => {
    for (const b of browsers) b.ws.terminate();
    await client.close();
    await bridge.close();
  });

  it("binds to loopback only", async () => {
    await start();
    const address = (bridge as unknown as { http: { address(): { address: string } } }).http.address();
    expect(address.address).toBe("127.0.0.1");
  });

  it("tells the model how to connect when no editor is attached", async () => {
    await start();
    const res = await client.callTool({ name: "get_project", arguments: {} });
    expect(res.isError).toBe(true);
    expect(text(res)).toContain("No OpenCut editor is connected");
    expect(text(res)).toContain(`token=${TOKEN}`);
    const status = await client.callTool({ name: "editor_status", arguments: {} });
    expect(JSON.parse(text(status))).toMatchObject({ connected: false });
  });

  it("rejects a wrong token and never exposes tools", async () => {
    await start();
    const b = new FakeBrowser(url, { token: "wrong" });
    browsers.push(b);
    expect(await b.rejectReason).toBe("Invalid token");
    expect(await b.closed()).toBe(4401);
    expect(bridge.editor).toBeNull();
  });

  it("rejects a protocol version it does not speak", async () => {
    await start();
    const b = new FakeBrowser(url, { protocol: 99 });
    browsers.push(b);
    expect(await b.rejectReason).toContain("Unsupported protocol");
  });

  it("rejects non-loopback browser origins at the upgrade", async () => {
    await start();
    const b = new FakeBrowser(url, { origin: "https://evil.example" });
    browsers.push(b);
    expect(await b.closed()).toBe(1006);
    expect(bridge.editor).toBeNull();
    expect(logs.join("\n")).toContain("rejected connection from origin https://evil.example");
  });

  it("accepts loopback and explicitly allowed origins", async () => {
    await start({ allowedOrigins: ["https://editor.example"] });
    await connectBrowser({ origin: "http://localhost:5173" });
    expect(bridge.editor?.projectId).toBe("proj-1");
    const second = await connectBrowser({ origin: "https://editor.example" });
    expect(second.ws.readyState).toBe(WebSocket.OPEN);
  });

  it("closes connections that do not say hello first or in time", async () => {
    await start({ helloTimeoutMs: 80 });
    const silent = new FakeBrowser(url, { hello: false });
    browsers.push(silent);
    expect(await silent.closed()).toBe(4408);
    const rude = new FakeBrowser(url, { hello: false });
    browsers.push(rude);
    await new Promise<void>((r) => rude.ws.on("open", () => r()));
    rude.ws.send(JSON.stringify({ type: "pong", id: "x" }));
    expect(await rude.rejectReason).toContain("hello");
  });

  it("drops a client that sends an oversized frame", async () => {
    await start();
    const b = await connectBrowser();
    b.ws.send("x".repeat(MAX_MESSAGE_BYTES + 1024));
    expect(await b.closed()).toBe(1009);
    await until(() => bridge.editor === null, "detach");
  });

  it("lists browser tools with their JSON schemas and read-only hints", async () => {
    await start();
    await connectBrowser();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(["editor_status", "get_project", "render_frame", "add_clip"]);
    const render = tools.find((t) => t.name === "render_frame");
    expect(render?.inputSchema).toMatchObject({ type: "object", required: ["time"], properties: { time: { type: "number" } } });
    expect(render?.annotations?.readOnlyHint).toBe(true);
    expect(tools.find((t) => t.name === "add_clip")?.annotations?.readOnlyHint).toBe(false);
  });

  it("forwards calls and converts text, data and images", async () => {
    await start();
    const b = await connectBrowser();
    b.handler = (name) => name === "render_frame"
      ? { ok: true, summary: "Rendered", data: { w: 4 }, images: [{ mediaType: "image/jpeg", base64: "QUJD", caption: "frame at 1.00s" }] }
      : { ok: true, summary: "fine" };
    const res = await client.callTool({ name: "render_frame", arguments: { time: 1 } });
    expect(b.calls).toEqual([{ name: "render_frame", input: { time: 1 } }]);
    expect(res.isError).toBeFalsy();
    expect(res.content).toEqual([
      { type: "text", text: "Rendered" },
      { type: "text", text: JSON.stringify({ w: 4 }, null, 1) },
      { type: "text", text: "frame at 1.00s" },
      { type: "image", data: "QUJD", mimeType: "image/jpeg" },
    ]);
  });

  it("returns multi-megabyte images unmodified", async () => {
    await start();
    const b = await connectBrowser();
    const data = "Z".repeat(10 * 1024 * 1024);
    b.handler = () => ({ ok: true, summary: "big", images: [{ mediaType: "image/jpeg", base64: data }] });
    const res = await client.callTool({ name: "render_frame", arguments: { time: 0 } });
    const image = (res.content as Array<{ type: string; data?: string }>).find((c) => c.type === "image");
    expect(image?.data?.length).toBe(data.length);
  });

  it("maps tool failures to isError results with the hint", async () => {
    await start();
    const b = await connectBrowser();
    b.handler = () => ({ ok: false, error: "time out of range", hint: "use 0..5" });
    const res = await client.callTool({ name: "render_frame", arguments: { time: 99 } });
    expect(res.isError).toBe(true);
    expect(text(res)).toBe("time out of range\nHint: use 0..5");
  });

  it("rejects unknown tools without bothering the editor", async () => {
    await start();
    const b = await connectBrowser();
    const res = await client.callTool({ name: "teleport", arguments: {} });
    expect(res.isError).toBe(true);
    expect(text(res)).toContain("Unknown tool 'teleport'");
    expect(b.calls).toHaveLength(0);
  });

  it("reports a timeout when the editor never answers", async () => {
    await start({ callTimeoutMs: 60 });
    const b = await connectBrowser();
    b.handler = () => "never";
    const res = await client.callTool({ name: "add_clip", arguments: {} });
    expect(res.isError).toBe(true);
    expect(text(res)).toContain("did not answer 'add_clip'");
  });

  it("fails an in-flight call when the editor disconnects", async () => {
    await start();
    const b = await connectBrowser();
    b.handler = () => "never";
    const pending = client.callTool({ name: "add_clip", arguments: {} });
    await until(() => b.calls.length === 1, "call delivery");
    b.ws.terminate();
    const res = await pending;
    expect(res.isError).toBe(true);
    expect(text(res)).toContain("disconnected during 'add_clip'");
  });

  it("keeps the last tool list after a disconnect but answers calls with connect instructions", async () => {
    await start();
    const b = await connectBrowser();
    b.close();
    await until(() => bridge.editor === null, "detach");
    expect((await client.listTools()).tools.length).toBe(4);
    const res = await client.callTool({ name: "get_project", arguments: {} });
    expect(res.isError).toBe(true);
    expect(text(res)).toContain("No OpenCut editor is connected");
  });

  it("refreshes tools and notifies the MCP client when the editor reconnects", async () => {
    await start();
    let notified = 0;
    client.setNotificationHandler(ToolListChangedNotificationSchema, () => { notified++; });
    const first = await connectBrowser();
    await until(() => notified >= 1, "first notification");
    first.close();
    await until(() => bridge.editor === null, "detach");
    const second = new FakeBrowser(url);
    browsers.push(second);
    second.tools = [{ name: "only_tool", description: "x", inputSchema: { type: "object", properties: {} }, readOnly: true }];
    await second.ackReceived;
    await until(() => bridge.toolList.some((t) => t.name === "only_tool"), "refreshed list");
    await until(() => notified >= 2, "second notification");
    expect((await client.listTools()).tools.map((t) => t.name)).toEqual(["editor_status", "only_tool"]);
  });

  it("lets a newer editor connection replace the old one", async () => {
    await start();
    const first = await connectBrowser();
    const second = await connectBrowser();
    expect(await first.closed()).toBe(4409);
    const res = await client.callTool({ name: "get_project", arguments: {} });
    expect(res.isError).toBeFalsy();
    expect(second.calls).toHaveLength(1);
  });

  it("answers editor_status when connected", async () => {
    await start();
    await connectBrowser();
    const status = await client.callTool({ name: "editor_status", arguments: {} });
    expect(JSON.parse(text(status))).toEqual({ connected: true, projectId: "proj-1", editorVersion: "t", tools: 3 });
    await bridge.ping();
  });

  it("serves a plain refusal to non-WebSocket HTTP requests", async () => {
    await start();
    const res = await fetch(url.replace("ws:", "http:"));
    expect(res.status).toBe(426);
  });
});
