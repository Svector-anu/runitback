import type { JsonSchema, ToolResult } from "#/engine/agent";

/** Wire format shared by the browser bridge and the Node MCP server. Text frames, one JSON object each. */
export const BRIDGE_PROTOCOL_VERSION = 1;
export const MAX_MESSAGE_BYTES = 32 * 1024 * 1024;
export const DEFAULT_BRIDGE_PORT = 7777;

export interface ToolDescriptor {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  readOnly: boolean;
}

export interface HelloMessage {
  type: "hello";
  protocol: number;
  token: string;
  editorVersion: string;
  projectId: string | null;
}

export type BrowserMessage =
  | HelloMessage
  | { type: "tools"; id: string; tools: ToolDescriptor[] }
  | { type: "result"; id: string; result: ToolResult }
  | { type: "pong"; id: string };

export type ServerMessage =
  | { type: "hello_ack"; protocol: number; sessionId: string }
  | { type: "reject"; reason: string }
  | { type: "list_tools"; id: string }
  | { type: "call_tool"; id: string; name: string; input: unknown }
  | { type: "ping"; id: string };

export class ProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProtocolError";
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Parses and structurally validates one frame; throws ProtocolError with a message safe to send back. */
export function decodeMessage(raw: string): Record<string, unknown> & { type: string } {
  if (raw.length > MAX_MESSAGE_BYTES) throw new ProtocolError("Message exceeds the size cap");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ProtocolError("Message is not valid JSON");
  }
  if (!isRecord(parsed) || typeof parsed.type !== "string") throw new ProtocolError("Message must be an object with a string 'type'");
  return parsed as Record<string, unknown> & { type: string };
}

export function encodeMessage(message: BrowserMessage | ServerMessage): string {
  const text = JSON.stringify(message);
  if (text.length > MAX_MESSAGE_BYTES) throw new ProtocolError("Message exceeds the size cap");
  return text;
}

export function parseBrowserMessage(raw: string): BrowserMessage {
  const m = decodeMessage(raw);
  switch (m.type) {
    case "hello":
      if (typeof m.protocol !== "number" || typeof m.token !== "string" || typeof m.editorVersion !== "string") throw new ProtocolError("Malformed hello");
      return { type: "hello", protocol: m.protocol, token: m.token, editorVersion: m.editorVersion, projectId: typeof m.projectId === "string" ? m.projectId : null };
    case "tools":
      if (typeof m.id !== "string" || !Array.isArray(m.tools)) throw new ProtocolError("Malformed tools message");
      return { type: "tools", id: m.id, tools: m.tools as ToolDescriptor[] };
    case "result":
      if (typeof m.id !== "string" || !isRecord(m.result) || typeof m.result.ok !== "boolean") throw new ProtocolError("Malformed result message");
      return { type: "result", id: m.id, result: m.result as unknown as ToolResult };
    case "pong":
      if (typeof m.id !== "string") throw new ProtocolError("Malformed pong");
      return { type: "pong", id: m.id };
    default:
      throw new ProtocolError(`Unknown message type '${m.type}'`);
  }
}

export function parseServerMessage(raw: string): ServerMessage {
  const m = decodeMessage(raw);
  switch (m.type) {
    case "hello_ack":
      if (typeof m.protocol !== "number" || typeof m.sessionId !== "string") throw new ProtocolError("Malformed hello_ack");
      return { type: "hello_ack", protocol: m.protocol, sessionId: m.sessionId };
    case "reject":
      return { type: "reject", reason: typeof m.reason === "string" ? m.reason : "rejected" };
    case "list_tools":
    case "ping":
      if (typeof m.id !== "string") throw new ProtocolError(`Malformed ${m.type}`);
      return { type: m.type, id: m.id };
    case "call_tool":
      if (typeof m.id !== "string" || typeof m.name !== "string") throw new ProtocolError("Malformed call_tool");
      return { type: "call_tool", id: m.id, name: m.name, input: m.input };
    default:
      throw new ProtocolError(`Unknown message type '${m.type}'`);
  }
}

export class RpcTimeoutError extends Error {
  constructor(readonly requestId: string, readonly timeoutMs: number) {
    super(`No response within ${timeoutMs}ms`);
    this.name = "RpcTimeoutError";
  }
}

export class RpcClosedError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "RpcClosedError";
  }
}

export interface Timers {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

const REAL_TIMERS: Timers = { set: (fn, ms) => setTimeout(fn, ms), clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>) };

/** Correlates request ids with responses, with a per-request timeout. */
export class RpcCorrelator<T> {
  private readonly pending = new Map<string, { resolve(v: T): void; reject(e: Error): void; timer: unknown }>();
  private counter = 0;

  constructor(private readonly timers: Timers = REAL_TIMERS) {}

  get size(): number {
    return this.pending.size;
  }

  nextId(): string {
    return `r${++this.counter}`;
  }

  /** Registers a request. `send` is called after registration so a synchronous reply is never lost. */
  request(input: { timeoutMs: number; send(id: string): void }): Promise<T> {
    const id = this.nextId();
    return new Promise<T>((resolve, reject) => {
      const timer = this.timers.set(() => {
        this.pending.delete(id);
        reject(new RpcTimeoutError(id, input.timeoutMs));
      }, input.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        input.send(id);
      } catch (error) {
        this.timers.clear(timer);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  /** Returns false when no request is waiting for this id (late or duplicate reply). */
  settle(id: string, value: T): boolean {
    const entry = this.pending.get(id);
    if (!entry) return false;
    this.timers.clear(entry.timer);
    this.pending.delete(id);
    entry.resolve(value);
    return true;
  }

  rejectAll(reason: string): void {
    for (const [id, entry] of this.pending) {
      this.timers.clear(entry.timer);
      entry.reject(new RpcClosedError(reason));
      this.pending.delete(id);
    }
  }
}

/** Reconnect delay: exponential with a cap; jitter is injected so tests stay deterministic. */
export function backoffDelay(input: { attempt: number; baseMs: number; maxMs: number; random?: () => number }): number {
  const exp = Math.min(input.maxMs, input.baseMs * 2 ** Math.max(0, input.attempt));
  const jitter = (input.random ?? Math.random)() * 0.25 * exp;
  return Math.min(input.maxMs, Math.round(exp + jitter));
}

export function isLoopbackHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "");
  return h === "localhost" || h === "127.0.0.1" || h === "::1" || /^127(\.\d{1,3}){3}$/.test(h);
}

/** `Host` header (may include a port) is loopback; defends against DNS rebinding. */
export function isLoopbackHostHeader(header: string | undefined): boolean {
  if (!header) return false;
  const withoutPort = header.startsWith("[") ? header.slice(0, header.indexOf("]") + 1) : header.replace(/:\d+$/, "");
  return isLoopbackHost(withoutPort);
}

/** True when an `Origin` header is absent (non-browser client), loopback, or explicitly allowed. */
export function isAllowedOrigin(origin: string | undefined, extraAllowed: ReadonlyArray<string> = []): boolean {
  if (origin === undefined || origin === "") return true;
  if (extraAllowed.includes(origin)) return true;
  try {
    return isLoopbackHost(new URL(origin).hostname);
  } catch {
    return false;
  }
}
