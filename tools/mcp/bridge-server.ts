import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type Server as HttpServer } from "node:http";
import { WebSocketServer, type RawData, type WebSocket } from "ws";
import type { ToolResult } from "../../src/engine/agent/types";
import {
  BRIDGE_PROTOCOL_VERSION, MAX_MESSAGE_BYTES, ProtocolError, RpcCorrelator, RpcTimeoutError, encodeMessage, isAllowedOrigin,
  isLoopbackHostHeader, parseBrowserMessage, type BrowserMessage, type ServerMessage, type ToolDescriptor,
} from "../../src/platform/agent-bridge-protocol";

export interface BridgeServerOptions {
  /** 0 picks a free port (tests). */
  port: number;
  /** Fixed token for tests; production generates a random one per process. */
  token?: string;
  /** Extra browser origins allowed besides loopback, e.g. a self-hosted editor. */
  allowedOrigins?: ReadonlyArray<string>;
  helloTimeoutMs?: number;
  callTimeoutMs?: number;
  listTimeoutMs?: number;
  log?: (line: string) => void;
}

export interface EditorInfo {
  sessionId: string;
  editorVersion: string;
  projectId: string | null;
}

export class NoEditorError extends Error {
  constructor() {
    super("No editor is connected");
    this.name = "NoEditorError";
  }
}

const REJECT_CODE = 4401;

type Reply = Extract<BrowserMessage, { type: "tools" | "result" | "pong" }>;

interface Connection {
  socket: WebSocket;
  info: EditorInfo;
}

/** Loopback WebSocket server the editor tab connects to. At most one editor is attached at a time. */
export class BridgeServer {
  readonly token: string;
  private readonly http: HttpServer = createServer((_req, res) => {
    res.writeHead(426, { "content-type": "text/plain" });
    res.end("RunItBack agent bridge: WebSocket only");
  });
  private readonly wss: WebSocketServer;
  private readonly rpc = new RpcCorrelator<Reply>();
  private current: Connection | null = null;
  private tools: ToolDescriptor[] = [];
  private readonly listeners = { connect: new Set<(info: EditorInfo) => void>(), disconnect: new Set<() => void>(), tools: new Set<() => void>() };

  constructor(private readonly options: BridgeServerOptions) {
    this.token = options.token ?? randomBytes(24).toString("hex");
    this.wss = new WebSocketServer({ server: this.http, maxPayload: MAX_MESSAGE_BYTES, verifyClient: (info, done) => this.verify(info, done) });
    this.wss.on("connection", (socket) => this.onConnection(socket));
  }

  private log(line: string): void {
    this.options.log?.(line);
  }

  private verify(info: { origin: string; req: { headers: Record<string, string | string[] | undefined> } }, done: (ok: boolean, code?: number, message?: string) => void): void {
    const host = info.req.headers.host;
    if (!isLoopbackHostHeader(typeof host === "string" ? host : undefined)) return done(false, 403, "Host must be loopback");
    if (!isAllowedOrigin(info.origin || undefined, this.options.allowedOrigins)) {
      this.log(`rejected connection from origin ${info.origin}`);
      return done(false, 403, "Origin not allowed");
    }
    done(true);
  }

  /** Starts listening on 127.0.0.1 only and resolves with the bound port. */
  listen(): Promise<number> {
    return new Promise((resolve, reject) => {
      this.http.once("error", reject);
      this.http.listen(this.options.port, "127.0.0.1", () => {
        this.http.off("error", reject);
        const address = this.http.address();
        resolve(typeof address === "object" && address ? address.port : this.options.port);
      });
    });
  }

  async close(): Promise<void> {
    this.rpc.rejectAll("Bridge server closed");
    for (const client of this.wss.clients) client.close(1001, "server closing");
    await new Promise<void>((resolve) => this.wss.close(() => resolve()));
    await new Promise<void>((resolve) => { this.http.close(() => resolve()); this.http.closeAllConnections(); });
  }

  get editor(): EditorInfo | null {
    return this.current?.info ?? null;
  }

  get toolList(): ReadonlyArray<ToolDescriptor> {
    return this.tools;
  }

  on(event: "connect", listener: (info: EditorInfo) => void): () => void;
  on(event: "disconnect" | "tools", listener: () => void): () => void;
  on(event: "connect" | "disconnect" | "tools", listener: ((info: EditorInfo) => void) | (() => void)): () => void {
    const set = this.listeners[event] as Set<typeof listener>;
    set.add(listener);
    return () => set.delete(listener);
  }

  private onConnection(socket: WebSocket): void {
    let attached: Connection | null = null;
    const helloTimer = setTimeout(() => socket.close(4408, "hello timeout"), this.options.helloTimeoutMs ?? 5000);
    const reject = (reason: string): void => {
      clearTimeout(helloTimer);
      this.sendTo(socket, { type: "reject", reason });
      socket.close(REJECT_CODE, reason.slice(0, 120));
    };

    socket.on("message", (data: RawData, isBinary: boolean) => {
      if (isBinary) return reject("Binary frames are not supported");
      let message: BrowserMessage;
      try {
        message = parseBrowserMessage(data.toString());
      } catch (error) {
        return reject(error instanceof ProtocolError ? error.message : "Malformed message");
      }
      if (!attached) {
        if (message.type !== "hello") return reject("Expected hello as the first message");
        clearTimeout(helloTimer);
        if (message.protocol !== BRIDGE_PROTOCOL_VERSION) return reject(`Unsupported protocol ${message.protocol}; this server speaks ${BRIDGE_PROTOCOL_VERSION}`);
        if (!this.tokenMatches(message.token)) return reject("Invalid token");
        attached = this.attach(socket, message);
        return;
      }
      if (message.type === "hello") return;
      this.rpc.settle(message.id, message);
    });
    socket.on("close", () => {
      clearTimeout(helloTimer);
      if (attached && this.current === attached) this.detach();
    });
    socket.on("error", (error) => this.log(`socket error: ${error.message}`));
  }

  private tokenMatches(candidate: string): boolean {
    const a = Buffer.from(candidate);
    const b = Buffer.from(this.token);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  private attach(socket: WebSocket, hello: Extract<BrowserMessage, { type: "hello" }>): Connection {
    if (this.current) {
      this.current.socket.close(4409, "replaced by a newer editor connection");
      this.detach();
    }
    const info: EditorInfo = { sessionId: randomBytes(8).toString("hex"), editorVersion: hello.editorVersion, projectId: hello.projectId };
    const connection: Connection = { socket, info };
    this.current = connection;
    this.sendTo(socket, { type: "hello_ack", protocol: BRIDGE_PROTOCOL_VERSION, sessionId: info.sessionId });
    this.log(`editor connected (project ${info.projectId ?? "none"})`);
    void this.refreshTools().catch((error: unknown) => this.log(`could not list tools: ${error instanceof Error ? error.message : String(error)}`));
    for (const l of this.listeners.connect) l(info);
    return connection;
  }

  private detach(): void {
    this.current = null;
    this.rpc.rejectAll("Editor disconnected");
    this.log("editor disconnected");
    for (const l of this.listeners.disconnect) l();
  }

  private sendTo(socket: WebSocket, message: ServerMessage): void {
    if (socket.readyState === socket.OPEN) socket.send(encodeMessage(message));
  }

  private request(build: (id: string) => ServerMessage, timeoutMs: number): Promise<Reply> {
    const connection = this.current;
    if (!connection) return Promise.reject(new NoEditorError());
    return this.rpc.request({ timeoutMs, send: (id) => this.sendTo(connection.socket, build(id)) });
  }

  async refreshTools(): Promise<ReadonlyArray<ToolDescriptor>> {
    const reply = await this.request((id) => ({ type: "list_tools", id }), this.options.listTimeoutMs ?? 10_000);
    if (reply.type !== "tools") throw new ProtocolError("Editor answered list_tools with the wrong message");
    this.tools = reply.tools;
    for (const l of this.listeners.tools) l();
    return this.tools;
  }

  async ping(timeoutMs = 3000): Promise<void> {
    await this.request((id) => ({ type: "ping", id }), timeoutMs);
  }

  /** Runs a tool in the editor. Rejects with NoEditorError, RpcTimeoutError or RpcClosedError; tool failures come back as `ok: false`. */
  async callTool(name: string, input: unknown): Promise<ToolResult> {
    const reply = await this.request((id) => ({ type: "call_tool", id, name, input }), this.options.callTimeoutMs ?? 120_000);
    if (reply.type !== "result") throw new ProtocolError("Editor answered call_tool with the wrong message");
    return reply.result;
  }
}

export { RpcTimeoutError };
