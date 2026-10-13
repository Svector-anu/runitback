import {
  BRIDGE_PROTOCOL_VERSION, bridgePortRange, parseServerMessage, type PairRejectReason, type ServerMessage,
} from "./agent-bridge-protocol";
import type { BridgeSocket } from "./agent-bridge";

export type SocketFactory = (url: string) => BridgeSocket;

export interface FoundBridge {
  port: number;
  /** A pairing code is currently live on that server. */
  pairing: boolean;
}

export type PairOutcome =
  | { ok: true; token: string }
  | { ok: false; reason: PairRejectReason | "unreachable" | "protocol"; retriesLeft: number };

const DEFAULT_TIMEOUT_MS = 800;

/** Opens a socket, sends one frame and resolves with the server's first answer, or null on error/timeout. */
function exchange(input: { createSocket: SocketFactory; port: number; frame: object; timeoutMs: number }): Promise<ServerMessage | null> {
  return new Promise((resolve) => {
    let socket: BridgeSocket;
    let settled = false;
    const finish = (value: ServerMessage | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        socket.close(1000, "done");
      } catch {
        // Already closed: nothing left to release.
      }
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), input.timeoutMs);
    try {
      socket = input.createSocket(`ws://127.0.0.1:${input.port}`);
    } catch {
      clearTimeout(timer);
      resolve(null);
      return;
    }
    socket.onopen = () => socket.send(JSON.stringify(input.frame));
    socket.onmessage = (event) => {
      try {
        finish(parseServerMessage(String(event.data)));
      } catch {
        finish(null);
      }
    };
    socket.onerror = () => finish(null);
    socket.onclose = () => finish(null);
  });
}

/** Asks each port in the bridge range whether a RunItBack bridge answers. Sequential so the console stays quiet. */
export async function probeBridges(input: { createSocket: SocketFactory; ports?: ReadonlyArray<number>; timeoutMs?: number; isCancelled?: () => boolean }): Promise<FoundBridge[]> {
  const found: FoundBridge[] = [];
  for (const port of input.ports ?? bridgePortRange()) {
    if (input.isCancelled?.()) break;
    const reply = await exchange({ createSocket: input.createSocket, port, frame: { type: "probe" }, timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS });
    if (reply?.type === "bridge_info" && reply.protocol === BRIDGE_PROTOCOL_VERSION) found.push({ port, pairing: reply.pairing });
  }
  return found;
}

/** Exchanges a 6-digit code for the session token. The code is sent only to the loopback server the user chose. */
export async function pairWithBridge(input: { createSocket: SocketFactory; port: number; code: string; timeoutMs?: number }): Promise<PairOutcome> {
  const reply = await exchange({ createSocket: input.createSocket, port: input.port, frame: { type: "pair", code: input.code }, timeoutMs: input.timeoutMs ?? 3000 });
  if (!reply) return { ok: false, reason: "unreachable", retriesLeft: 0 };
  if (reply.type === "paired") return { ok: true, token: reply.token };
  if (reply.type === "pair_reject") return { ok: false, reason: reply.reason, retriesLeft: reply.retriesLeft };
  return { ok: false, reason: "protocol", retriesLeft: 0 };
}
