import { describe, expect, it } from "vitest";
import { PairingManager } from "../tools/mcp/pairing";

function clock(): { now: () => number; advance: (ms: number) => void } {
  let t = 1_000;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

function manager(code = 42): { pairing: PairingManager; clock: ReturnType<typeof clock> } {
  const c = clock();
  return { pairing: new PairingManager({ now: c.now, randomBelow: () => code }), clock: c };
}

const ORIGIN = "http://localhost:5173";

describe("PairingManager", () => {
  it("issues a zero padded 6-digit code", () => {
    expect(manager(42).pairing.issue().code).toBe("000042");
    expect(manager(999_999).pairing.issue().code).toBe("999999");
  });

  it("accepts the right code once, then the code is gone", () => {
    const { pairing } = manager();
    const { code } = pairing.issue();
    expect(pairing.redeem({ code, origin: ORIGIN })).toEqual({ ok: true });
    expect(pairing.redeem({ code, origin: ORIGIN })).toMatchObject({ ok: false, reason: "no_code" });
    expect(pairing.hasActiveCode).toBe(false);
  });

  it("expires after 2 minutes", () => {
    const { pairing, clock: c } = manager();
    const { code } = pairing.issue();
    c.advance(119_999);
    expect(pairing.hasActiveCode).toBe(true);
    c.advance(1);
    expect(pairing.hasActiveCode).toBe(false);
    expect(pairing.redeem({ code, origin: ORIGIN })).toMatchObject({ ok: false, reason: "no_code" });
  });

  it("reports expiry for a code redeemed after the deadline", () => {
    const { pairing, clock: c } = manager();
    const { code } = pairing.issue();
    c.advance(120_000);
    expect(pairing.redeem({ code, origin: ORIGIN })).toMatchObject({ ok: false, reason: "expired" });
  });

  it("allows three wrong tries and then burns the code, even for the right digits", () => {
    const { pairing } = manager();
    const { code } = pairing.issue();
    expect(pairing.redeem({ code: "111111", origin: ORIGIN })).toEqual({ ok: false, reason: "wrong_code", retriesLeft: 2 });
    expect(pairing.redeem({ code: "222222", origin: ORIGIN })).toEqual({ ok: false, reason: "wrong_code", retriesLeft: 1 });
    expect(pairing.redeem({ code: "333333", origin: ORIGIN })).toEqual({ ok: false, reason: "wrong_code", retriesLeft: 0 });
    expect(pairing.redeem({ code, origin: ORIGIN })).toMatchObject({ ok: false, reason: "no_code" });
    expect(pairing.failedAttempts).toBe(3);
  });

  it("binds the code to the origin of the first attempt", () => {
    const { pairing } = manager();
    const { code } = pairing.issue();
    expect(pairing.redeem({ code: "000001", origin: ORIGIN })).toMatchObject({ reason: "wrong_code" });
    expect(pairing.redeem({ code, origin: "http://localhost:3000" })).toMatchObject({ ok: false, reason: "origin_mismatch", retriesLeft: 1 });
    expect(pairing.redeem({ code, origin: ORIGIN })).toEqual({ ok: true });
  });

  it("asking for the code again does not refresh tries or the deadline", () => {
    const { pairing, clock: c } = manager();
    const first = pairing.issue();
    pairing.redeem({ code: "000001", origin: ORIGIN });
    c.advance(60_000);
    const again = pairing.issue();
    expect(again).toEqual({ code: first.code, expiresAt: first.expiresAt, retriesLeft: 2 });
  });

  it("mints a fresh code once the old one is used up", () => {
    const c = clock();
    const values = [1, 2];
    const pairing = new PairingManager({ now: c.now, randomBelow: () => values.shift() ?? 0 });
    const first = pairing.issue();
    pairing.redeem({ code: first.code, origin: ORIGIN });
    expect(pairing.issue().code).toBe("000002");
  });

  it("rejects when nothing was ever issued", () => {
    expect(manager().pairing.redeem({ code: "000042", origin: ORIGIN })).toMatchObject({ ok: false, reason: "no_code" });
  });

  it("does not accept a code with different length or prefix", () => {
    const { pairing } = manager(123456);
    pairing.issue();
    expect(pairing.redeem({ code: "12345", origin: ORIGIN }).ok).toBe(false);
    expect(pairing.redeem({ code: "1234567", origin: ORIGIN }).ok).toBe(false);
  });
});
