import { describe, expect, it } from "vitest";
import { AnthropicModelClient } from "#/app/agent/model-client";
import { OpenAiModelClient } from "#/app/agent/model-client-openai";
import { MODEL_PROVIDERS, createModelClient, pricingFor, resolveProviderId } from "#/app/agent/model-providers";

const ok = (urls: string[]): typeof fetch => async (input) => {
  urls.push(String(input));
  return new Response(JSON.stringify({ choices: [{ message: { content: "x" }, finish_reason: "stop" }] }), { status: 200, headers: { "content-type": "application/json" } });
};
const REQUEST = { model: "m", system: "s", tools: [], messages: [{ role: "user" as const, content: [{ type: "text" as const, text: "hi" }] }], maxTokens: 8 };

describe("model providers", () => {
  it("builds the right client class per provider", () => {
    expect(createModelClient({ provider: "anthropic", apiKey: "k" })).toBeInstanceOf(AnthropicModelClient);
    expect(createModelClient({ provider: "openai-compatible", apiKey: "k" })).toBeInstanceOf(OpenAiModelClient);
  });

  it("uses the provider default base URL unless one is given", async () => {
    const urls: string[] = [];
    await createModelClient({ provider: "openai-compatible", apiKey: "k", fetch: ok(urls) }).complete(REQUEST);
    await createModelClient({ provider: "openai-compatible", apiKey: "k", baseUrl: "https://other.example/v1", fetch: ok(urls) }).complete(REQUEST);
    expect(urls).toEqual(["https://api.surplusintelligence.ai/v1/chat/completions", "https://other.example/v1/chat/completions"]);
  });

  it("resolves provider aliases and rejects unknown names", () => {
    expect(resolveProviderId("openai")).toBe("openai-compatible");
    expect(resolveProviderId("anthropic")).toBe("anthropic");
    expect(() => resolveProviderId("gemini")).toThrow(/Unknown provider/);
  });

  it("keeps separate key env names and defaults per provider", () => {
    expect(MODEL_PROVIDERS.anthropic.apiKeyEnv).toBe("ANTHROPIC_API_KEY");
    expect(MODEL_PROVIDERS["openai-compatible"].apiKeyEnv).toBe("OPENAI_API_KEY");
    expect(MODEL_PROVIDERS["openai-compatible"].models.some((m) => m.id === MODEL_PROVIDERS["openai-compatible"].defaultModel)).toBe(true);
    expect(pricingFor("openai-compatible", "gpt-5-mini")).toBeDefined();
    expect(pricingFor("anthropic", "claude-sonnet-5-5")).toBeUndefined();
  });
});
