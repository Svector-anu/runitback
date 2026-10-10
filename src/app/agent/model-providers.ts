import { AnthropicModelClient, DEFAULT_AGENT_MODEL, type ModelClient } from "./model-client";
import { OpenAiModelClient } from "./model-client-openai";

export type ModelProviderId = "anthropic" | "openai-compatible";

export interface ModelPricing {
  /** USD per million tokens. */
  input: number;
  output: number;
}

export interface ProviderModel {
  id: string;
  label: string;
  pricing?: ModelPricing;
}

export interface ProviderInfo {
  id: ModelProviderId;
  label: string;
  /** Names accepted by `--provider`. */
  aliases: readonly string[];
  apiKeyEnv: string;
  baseUrlEnv: string;
  defaultBaseUrl?: string;
  defaultModel: string;
  models: readonly ProviderModel[];
}

export const MODEL_PROVIDERS: Readonly<Record<ModelProviderId, ProviderInfo>> = {
  anthropic: {
    id: "anthropic",
    label: "Anthropic Messages API",
    aliases: ["anthropic"],
    apiKeyEnv: "ANTHROPIC_API_KEY",
    baseUrlEnv: "ANTHROPIC_BASE_URL",
    defaultModel: DEFAULT_AGENT_MODEL,
    models: [
      { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5" },
      { id: "claude-opus-5-5", label: "Claude Opus 5.5" },
      { id: "claude-haiku-5-5", label: "Claude Haiku 5.5" },
    ],
  },
  "openai-compatible": {
    id: "openai-compatible",
    label: "OpenAI-compatible chat completions",
    aliases: ["openai", "openai-compatible"],
    apiKeyEnv: "OPENAI_API_KEY",
    baseUrlEnv: "OPENAI_BASE_URL",
    defaultBaseUrl: "https://api.surplusintelligence.ai/v1",
    defaultModel: "gpt-5-mini",
    models: [
      { id: "gpt-5-mini", label: "GPT-5 mini", pricing: { input: 0.25, output: 2 } },
      { id: "gpt-5.3-codex", label: "GPT-5.3 Codex" },
      { id: "mercury-2.5", label: "Mercury 2.5" },
    ],
  },
};

export function resolveProviderId(name: string): ModelProviderId {
  const found = Object.values(MODEL_PROVIDERS).find((p) => p.aliases.includes(name));
  if (!found) throw new Error(`Unknown provider "${name}". Known: ${Object.values(MODEL_PROVIDERS).flatMap((p) => p.aliases).join(", ")}`);
  return found.id;
}

export function pricingFor(provider: ModelProviderId, modelId: string): ModelPricing | undefined {
  return MODEL_PROVIDERS[provider].models.find((m) => m.id === modelId)?.pricing;
}

export interface CreateModelClientOptions {
  provider: ModelProviderId;
  apiKey: string;
  baseUrl?: string;
  fetch?: typeof fetch;
}

/** Builds a client for the chosen provider. Unset `baseUrl` falls back to the provider default. */
export function createModelClient(options: CreateModelClientOptions): ModelClient {
  const { provider, apiKey, fetch: fetchImpl } = options;
  const baseUrl = options.baseUrl ?? MODEL_PROVIDERS[provider].defaultBaseUrl;
  switch (provider) {
    case "anthropic":
      return new AnthropicModelClient({ apiKey, ...(baseUrl ? { baseUrl } : {}), ...(fetchImpl ? { fetch: fetchImpl } : {}) });
    case "openai-compatible":
      return new OpenAiModelClient({ apiKey, ...(baseUrl ? { baseUrl } : {}), ...(fetchImpl ? { fetch: fetchImpl } : {}) });
  }
}
