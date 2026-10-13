import { PAIRING_CODE_LENGTH, type PairRejectReason } from "#/platform/agent-bridge-protocol";
import type { BridgeSocket } from "#/platform/agent-bridge";
import { pairWithBridge, probeBridges, type PairOutcome } from "#/platform/agent-pairing";
import { connectBridgeWithPairedToken } from "./agent-bridge-wiring";

export type PairingPhase = "idle" | "searching" | "not_found" | "found" | "pairing" | "paired";

export interface PairingView {
  phase: PairingPhase;
  port: number | null;
  error: string | null;
}

const IDLE: PairingView = { phase: "idle", port: null, error: null };
const RETRY_DELAYS_MS = [2000, 4000, 8000];
const createSocket = (url: string): BridgeSocket => new WebSocket(url) as unknown as BridgeSocket;

export const REJECT_MESSAGES: Record<PairRejectReason | "unreachable" | "protocol", string> = {
  no_code: "That code is no longer valid. Ask Claude Code to \"show the pairing code\".",
  expired: "That code expired. Ask Claude Code to \"show the pairing code\".",
  wrong_code: "That is not the code. Check Claude Code's output.",
  origin_mismatch: "This page is not allowed to pair with that server.",
  malformed: "That does not look like a 6-digit code.",
  unreachable: "Could not reach Claude Code on this computer.",
  protocol: "Claude Code's server speaks a different version. Update runitback-mcp.",
};

export function describePairFailure(outcome: Extract<PairOutcome, { ok: false }>): string {
  const base = REJECT_MESSAGES[outcome.reason];
  return outcome.reason === "wrong_code" && outcome.retriesLeft > 0 ? `${base} ${outcome.retriesLeft} ${outcome.retriesLeft === 1 ? "try" : "tries"} left.` : base;
}

/**
 * Looks for a RunItBack bridge on loopback only while someone is looking at the Claude Code card (`start`/`stop`), never
 * in the background, and exchanges a typed code for the session token.
 */
class PairingController {
  private view: PairingView = IDLE;
  private readonly listeners = new Set<() => void>();
  private generation = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getView = (): PairingView => this.view;

  private set(next: PairingView): void {
    this.view = next;
    for (const l of this.listeners) l();
  }

  start = (): void => {
    if (this.view.phase !== "idle" && this.view.phase !== "paired") return;
    const generation = ++this.generation;
    this.set({ phase: "searching", port: null, error: null });
    void this.scan(generation, 0);
  };

  stop = (): void => {
    this.generation++;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.view.phase !== "idle") this.set(IDLE);
  };

  private async scan(generation: number, round: number): Promise<void> {
    const found = await probeBridges({ createSocket, isCancelled: () => generation !== this.generation });
    if (generation !== this.generation) return;
    const target = found.find((f) => f.pairing) ?? found[0];
    if (target) {
      this.set({ phase: "found", port: target.port, error: null });
      return;
    }
    this.set({ phase: "not_found", port: null, error: null });
    this.timer = setTimeout(() => {
      if (generation !== this.generation) return;
      this.set({ phase: "searching", port: null, error: null });
      void this.scan(generation, round + 1);
    }, RETRY_DELAYS_MS[Math.min(round, RETRY_DELAYS_MS.length - 1)]);
  }

  submit = async (rawCode: string): Promise<void> => {
    const port = this.view.port;
    const code = rawCode.replace(/\s+/g, "");
    if (port === null || this.view.phase !== "found") return;
    if (!new RegExp(`^\\d{${PAIRING_CODE_LENGTH}}$`).test(code)) {
      this.set({ ...this.view, error: REJECT_MESSAGES.malformed });
      return;
    }
    const generation = this.generation;
    this.set({ ...this.view, phase: "pairing", error: null });
    const outcome = await pairWithBridge({ createSocket, port, code });
    if (generation !== this.generation) return;
    if (outcome.ok) {
      this.set({ phase: "paired", port, error: null });
      connectBridgeWithPairedToken({ port, token: outcome.token });
      return;
    }
    this.set({ phase: "found", port, error: describePairFailure(outcome) });
  };
}

export const pairing = new PairingController();
