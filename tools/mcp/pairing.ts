import { randomInt } from "node:crypto";
import { PAIRING_CODE_LENGTH, PAIRING_CODE_TTL_MS, PAIRING_MAX_TRIES, type PairRejectReason } from "../../src/platform/agent-bridge-protocol";

export interface PairingOptions {
  now?: () => number;
  /** Returns a uniformly random integer in [0, max). Injected so tests are deterministic. */
  randomBelow?: (max: number) => number;
  ttlMs?: number;
  maxTries?: number;
}

export type RedeemResult = { ok: true } | { ok: false; reason: PairRejectReason; retriesLeft: number };

export interface IssuedCode {
  code: string;
  expiresAt: number;
  retriesLeft: number;
}

interface ActiveCode {
  code: string;
  expiresAt: number;
  failures: number;
  /** Origin of the first attempt. Later attempts from another origin fail and burn a try. */
  boundOrigin: string | null;
}

/**
 * One short-lived pairing code at a time. A code is single use, dies after `ttlMs`, dies after `maxTries` wrong attempts
 * and is bound to the origin that first tries it. Callers decide what a successful redemption grants.
 */
export class PairingManager {
  private active: ActiveCode | null = null;
  private failedTotal = 0;
  private readonly now: () => number;
  private readonly randomBelow: (max: number) => number;
  private readonly ttlMs: number;
  private readonly maxTries: number;

  constructor(options: PairingOptions = {}) {
    this.now = options.now ?? Date.now;
    this.randomBelow = options.randomBelow ?? ((max) => randomInt(max));
    this.ttlMs = options.ttlMs ?? PAIRING_CODE_TTL_MS;
    this.maxTries = options.maxTries ?? PAIRING_MAX_TRIES;
  }

  private live(): ActiveCode | null {
    if (this.active && this.now() >= this.active.expiresAt) this.active = null;
    return this.active && this.active.failures < this.maxTries ? this.active : null;
  }

  /** True while a code can still be redeemed (the page uses this to decide whether to show the code box). */
  get hasActiveCode(): boolean {
    return this.live() !== null;
  }

  /** Failed redemptions since startup; surfaced to the user in Claude Code so guessing is visible. */
  get failedAttempts(): number {
    return this.failedTotal;
  }

  /** Returns the current code, or mints a new one when none is live. Asking again never resets the try counter. */
  issue(): IssuedCode {
    const current = this.live();
    if (current) return { code: current.code, expiresAt: current.expiresAt, retriesLeft: this.maxTries - current.failures };
    const code = String(this.randomBelow(10 ** PAIRING_CODE_LENGTH)).padStart(PAIRING_CODE_LENGTH, "0");
    this.active = { code, expiresAt: this.now() + this.ttlMs, failures: 0, boundOrigin: null };
    return { code, expiresAt: this.active.expiresAt, retriesLeft: this.maxTries };
  }

  redeem(input: { code: string; origin: string | undefined }): RedeemResult {
    const entry = this.active;
    if (!entry) return { ok: false, reason: "no_code", retriesLeft: 0 };
    if (this.now() >= entry.expiresAt) {
      this.active = null;
      return { ok: false, reason: "expired", retriesLeft: 0 };
    }
    const origin = input.origin ?? "";
    if (entry.boundOrigin === null) entry.boundOrigin = origin;
    const sameOrigin = entry.boundOrigin === origin;
    if (!sameOrigin || !constantTimeEqual(input.code, entry.code)) {
      entry.failures += 1;
      this.failedTotal += 1;
      const retriesLeft = Math.max(0, this.maxTries - entry.failures);
      if (retriesLeft === 0) this.active = null;
      return { ok: false, reason: sameOrigin ? "wrong_code" : "origin_mismatch", retriesLeft };
    }
    this.active = null;
    return { ok: true };
  }
}

function constantTimeEqual(a: string, b: string): boolean {
  let diff = a.length ^ b.length;
  for (let i = 0; i < b.length; i++) diff |= (a.charCodeAt(i) || 0) ^ b.charCodeAt(i);
  return diff === 0;
}
