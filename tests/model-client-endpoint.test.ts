import { describe, expect, it } from "vitest";
import { AnthropicModelClient, ModelError, redactSecrets } from "#/app/agent/model-client";

const REQUEST = { model: "claude-opus-4.8", system: "s", tools: [], messages: [{ role: "user" as const, content: [{ type: "text" as const, text: "hi" }] }], maxTokens: 16 };

function recordingFetch(): { fetch: typeof fetch; urls: string[]; headers: Array<Headers> } {
  const urls: string[] = [];
  const headers: Headers[] = [];
  const fakeFetch: typeof fetch = async (input, init) => {
    urls.push(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    headers.push(new Headers(init?.headers));
    return new Response(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "stop here" } }), { status: 400, headers: { "content-type": "application/json" } });
  };
  return { fetch: fakeFetch, urls, headers };
}

describe("AnthropicModelClient endpoint", () => {
  it("posts to the configured Anthropic-compatible base URL and sends the key as x-api-key", async () => {
    const { fetch: fakeFetch, urls, headers } = recordingFetch();
    const client = new AnthropicModelClient({ apiKey: "inf_test_key_12345", baseUrl: "https://gateway.example/anthropic", fetch: fakeFetch });
    await expect(client.complete(REQUEST)).rejects.toBeInstanceOf(ModelError);
    expect(urls[0]).toBe("https://gateway.example/anthropic/v1/messages");
    expect(headers[0]?.get("x-api-key")).toBe("inf_test_key_12345");
  });

  it("defaults to api.anthropic.com when no base URL is given", async () => {
    const { fetch: fakeFetch, urls } = recordingFetch();
    const client = new AnthropicModelClient({ apiKey: "sk-ant-test-12345", fetch: fakeFetch });
    await expect(client.complete(REQUEST)).rejects.toBeInstanceOf(ModelError);
    expect(urls[0]).toBe("https://api.anthropic.com/v1/messages");
  });

  it("redacts gateway-style keys from error text", () => {
    expect(redactSecrets("bad key inf_abc123XYZ and inf_admin_k9", undefined)).toBe("bad key [redacted] and [redacted]");
  });
});
