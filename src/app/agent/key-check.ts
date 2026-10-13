export type KeyCheckResult =
  | { ok: true }
  | { ok: false; reason: "invalid" | "forbidden" | "rate-limited" | "network" | "other"; message: string };

export interface KeyCheckOptions {
  apiKey: string;
  fetch?: typeof fetch;
  signal?: AbortSignal;
}

const MESSAGES_URL = "https://api.anthropic.com/v1/messages";
const CHEAPEST_MODEL = "claude-haiku-5-5";

/**
 * Sends the smallest possible Messages request (one output token) straight from the browser to Anthropic.
 * The key is only placed in the request header; it never appears in a returned message.
 */
export async function checkApiKey({ apiKey, fetch: fetchImpl = globalThis.fetch.bind(globalThis), signal }: KeyCheckOptions): Promise<KeyCheckResult> {
  let response: Response;
  try {
    response = await fetchImpl(MESSAGES_URL, {
      method: "POST",
      signal,
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true",
      },
      body: JSON.stringify({ model: CHEAPEST_MODEL, max_tokens: 1, messages: [{ role: "user", content: "hi" }] }),
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    return { ok: false, reason: "network", message: "Could not reach Anthropic. Check your connection, VPN or ad blocker and try again." };
  }
  if (response.ok) return { ok: true };
  if (response.status === 401) return { ok: false, reason: "invalid", message: "Anthropic rejected this key (401). Check that you copied all of it and that it has not been revoked." };
  if (response.status === 403) return { ok: false, reason: "forbidden", message: "This key is not allowed to use the API (403). Check its workspace and permissions in the Anthropic console." };
  if (response.status === 429) return { ok: false, reason: "rate-limited", message: "The key is valid but rate limited right now (429). Wait a moment and try again." };
  if (response.status === 402 || response.status === 400) {
    const detail = await readErrorMessage(response);
    return { ok: false, reason: "other", message: `Anthropic returned ${response.status}${detail ? `: ${detail.replaceAll(apiKey, "[key]")}` : ""}. If it mentions credit, add credit in the console.` };
  }
  return { ok: false, reason: "other", message: `Anthropic returned an unexpected error (${response.status}). Try again shortly.` };
}

async function readErrorMessage(response: Response): Promise<string> {
  try {
    const body: unknown = await response.json();
    const error = typeof body === "object" && body !== null ? (body as { error?: { message?: unknown } }).error : undefined;
    return typeof error?.message === "string" ? error.message.slice(0, 200) : "";
  } catch {
    return "";
  }
}
