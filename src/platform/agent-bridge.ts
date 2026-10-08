import type { AgentTool, ToolContext, ToolResult } from "#/engine/agent";
import {
  BRIDGE_PROTOCOL_VERSION, MAX_MESSAGE_BYTES, backoffDelay, encodeMessage, parseServerMessage,
  type BrowserMessage, type ServerMessage, type Timers, type ToolDescriptor,
} from "./agent-bridge-protocol";

export interface BridgeSocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: { code: number; reason: string }) => void) | null;
  onerror: (() => void) | null;
}

export type BridgeState = "idle" | "connecting" | "connected" | "waiting" | "rejected" | "stopped";

export interface BridgeStatus {
  state: BridgeState;
  /** Consecutive failed connection attempts since the last successful handshake. */
  attempt: number;
  reason: string | null;
  sessionId: string | null;
}

export interface AgentBridgeOptions {
  url: string;
  token: string;
  tools: () => ReadonlyMap<string, AgentTool>;
  context: () => ToolContext;
  hello: () => { editorVersion: string; projectId: string | null };
  createSocket: (url: string) => BridgeSocket;
  timers?: Timers;
  random?: () => number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  handshakeTimeoutMs?: number;
}

const REJECT_CLOSE_CODE = 4401;
const REAL_TIMERS: Timers = { set: (fn, ms) => setTimeout(fn, ms), clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>) };

export function describeTools(tools: ReadonlyMap<string, AgentTool>): ToolDescriptor[] {
  return [...tools.values()].map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema, readOnly: t.readOnly }));
}

/**
 * Browser end of the agent bridge. Speaks the versioned JSON protocol over an injected socket, executes tool
 * calls one at a time (edits must not interleave) and reconnects with backoff until stopped.
 */
export class AgentBridgeClient {
  private socket: BridgeSocket | null = null;
  private status: BridgeStatus = { state: "idle", attempt: 0, reason: null, sessionId: null };
  private readonly listeners = new Set<(s: BridgeStatus) => void>();
  private reconnectTimer: unknown = null;
  private handshakeTimer: unknown = null;
  private queue: Promise<void> = Promise.resolve();
  private readonly timers: Timers;

  constructor(private readonly options: AgentBridgeOptions) {
    this.timers = options.timers ?? REAL_TIMERS;
  }

  getStatus(): BridgeStatus {
    return this.status;
  }

  subscribe(listener: (s: BridgeStatus) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  start(): void {
    if (this.status.state === "stopped" || this.status.state === "rejected") this.setStatus({ state: "idle", attempt: 0, reason: null });
    if (this.socket || this.reconnectTimer !== null) return;
    this.connect();
  }

  /** Clean shutdown: no further reconnects. */
  stop(reason = "Disconnected by user"): void {
    this.clearTimers();
    const socket = this.socket;
    this.socket = null;
    this.setStatus({ state: "stopped", reason, sessionId: null });
    if (socket) {
      detach(socket);
      try {
        socket.close(1000, "client closing");
      } catch {
        // The socket may already be closed; nothing left to release.
      }
    }
  }

  private setStatus(patch: Partial<BridgeStatus>): void {
    this.status = { ...this.status, ...patch };
    for (const l of this.listeners) l(this.status);
  }

  private clearTimers(): void {
    if (this.reconnectTimer !== null) this.timers.clear(this.reconnectTimer);
    if (this.handshakeTimer !== null) this.timers.clear(this.handshakeTimer);
    this.reconnectTimer = null;
    this.handshakeTimer = null;
  }

  private connect(): void {
    this.reconnectTimer = null;
    this.setStatus({ state: "connecting", reason: null });
    let socket: BridgeSocket;
    try {
      socket = this.options.createSocket(this.options.url);
    } catch (error) {
      this.scheduleReconnect(error instanceof Error ? error.message : "Could not open socket");
      return;
    }
    this.socket = socket;
    socket.onopen = () => {
      const hello = this.options.hello();
      this.send({ type: "hello", protocol: BRIDGE_PROTOCOL_VERSION, token: this.options.token, ...hello });
      this.handshakeTimer = this.timers.set(() => socket.close(4408, "handshake timeout"), this.options.handshakeTimeoutMs ?? 5000);
    };
    socket.onmessage = (event) => this.onFrame(event.data);
    socket.onerror = () => undefined;
    socket.onclose = (event) => {
      if (this.socket !== socket) return;
      this.socket = null;
      if (this.handshakeTimer !== null) this.timers.clear(this.handshakeTimer);
      this.handshakeTimer = null;
      if (this.status.state === "rejected" || event.code === REJECT_CLOSE_CODE) {
        this.setStatus({ state: "rejected", reason: this.status.reason ?? (event.reason || "Rejected by the MCP server") });
        return;
      }
      this.scheduleReconnect(event.reason || "Connection closed");
    };
  }

  private scheduleReconnect(reason: string): void {
    if (this.status.state === "stopped") return;
    const attempt = this.status.attempt + 1;
    const delay = backoffDelay({ attempt: attempt - 1, baseMs: this.options.baseDelayMs ?? 500, maxMs: this.options.maxDelayMs ?? 10_000, random: this.options.random });
    this.setStatus({ state: "waiting", attempt, reason, sessionId: null });
    this.reconnectTimer = this.timers.set(() => this.connect(), delay);
  }

  private send(message: BrowserMessage): void {
    const socket = this.socket;
    if (!socket) return;
    try {
      socket.send(encodeMessage(message));
    } catch (error) {
      if (message.type === "result") {
        const reason = error instanceof Error ? error.message : "unsendable";
        socket.send(encodeMessage({ type: "result", id: message.id, result: { ok: false, error: `Result could not be sent: ${reason}`, hint: "Request a smaller output (for example a smaller frame size)." } }));
      }
    }
  }

  private onFrame(data: unknown): void {
    if (typeof data !== "string" || data.length > MAX_MESSAGE_BYTES) return;
    let message: ServerMessage;
    try {
      message = parseServerMessage(data);
    } catch {
      return;
    }
    switch (message.type) {
      case "hello_ack":
        if (this.handshakeTimer !== null) this.timers.clear(this.handshakeTimer);
        this.handshakeTimer = null;
        this.setStatus({ state: "connected", attempt: 0, reason: null, sessionId: message.sessionId });
        return;
      case "reject":
        this.setStatus({ state: "rejected", reason: message.reason });
        return;
      case "ping":
        this.send({ type: "pong", id: message.id });
        return;
      case "list_tools":
        this.send({ type: "tools", id: message.id, tools: describeTools(this.options.tools()) });
        return;
      case "call_tool": {
        const { id, name, input } = message;
        this.queue = this.queue.then(async () => {
          const result = await this.execute(name, input);
          this.send({ type: "result", id, result });
        });
        return;
      }
    }
  }

  private async execute(name: string, input: unknown): Promise<ToolResult> {
    const tool = this.options.tools().get(name);
    if (!tool) return { ok: false, error: `Unknown tool '${name}'`, hint: "Call list_tools to see the tools this editor exposes." };
    try {
      return await tool.run(input, this.options.context());
    } catch (error) {
      return { ok: false, error: `Tool '${name}' threw: ${error instanceof Error ? error.message : String(error)}` };
    }
  }
}

function detach(socket: BridgeSocket): void {
  socket.onopen = null;
  socket.onmessage = null;
  socket.onclose = null;
  socket.onerror = null;
}
