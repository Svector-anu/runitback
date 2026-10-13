import { describe, expect, it, vi } from "vitest";
import { checkApiKey } from "#/app/agent/key-check";

const KEY = "sk-ant-secret-key-123";

function reply(status: number, body: unknown = {}): typeof fetch {
  return vi.fn(async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
}

describe("checkApiKey", () => {
  it("sends one minimal request to the Messages API with the key only in the header", async () => {
    const fetchSpy = reply(200);
    expect(await checkApiKey({ apiKey: KEY, fetch: fetchSpy })).toEqual({ ok: true });
    const [url, init] = (fetchSpy as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    expect((init.headers as Record<string, string>)["x-api-key"]).toBe(KEY);
    const body = JSON.parse(String(init.body)) as { max_tokens: number; model: string };
    expect(body.max_tokens).toBe(1);
    expect(String(init.body)).not.toContain(KEY);
  });

  it.each([
    [401, "invalid", /401/],
    [403, "forbidden", /403/],
    [429, "rate-limited", /429/],
    [500, "other", /500/],
  ] as const)("maps HTTP %i to %s with a readable message", async (status, reason, pattern) => {
    const result = await checkApiKey({ apiKey: KEY, fetch: reply(status) });
    expect(result).toMatchObject({ ok: false, reason });
    expect(result.ok === false && result.message).toMatch(pattern);
  });

  it("reports a network failure without leaking the key", async () => {
    const failing = vi.fn(async () => { throw new TypeError(`Failed to fetch ${KEY}`); }) as unknown as typeof fetch;
    const result = await checkApiKey({ apiKey: KEY, fetch: failing });
    expect(result).toMatchObject({ ok: false, reason: "network" });
    expect(JSON.stringify(result)).not.toContain(KEY);
  });

  it("redacts the key from provider error text on 400", async () => {
    const result = await checkApiKey({ apiKey: KEY, fetch: reply(400, { error: { message: `credit balance too low for ${KEY}` } }) });
    expect(JSON.stringify(result)).not.toContain(KEY);
    expect(result.ok === false && result.message).toContain("credit balance");
  });
});
