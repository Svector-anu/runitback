# Model providers

The agent talks to models only through `ModelClient` (`src/app/agent/model-client.ts`). Two implementations exist:

| Provider id | Class | Wire protocol | Key env (evals) | Base URL env (evals) |
| --- | --- | --- | --- | --- |
| `anthropic` (in-app default) | `AnthropicModelClient` | Messages API, streaming | `ANTHROPIC_API_KEY` | `ANTHROPIC_BASE_URL` |
| `openai-compatible` (`--provider openai`) | `OpenAiModelClient` (`model-client-openai.ts`) | Chat Completions, SSE streaming, function tools | `OPENAI_API_KEY` | `OPENAI_BASE_URL`, default `https://api.surplusintelligence.ai/v1` |

`createModelClient({ provider, apiKey, baseUrl?, fetch? })` and the provider/model registry live in `src/app/agent/model-providers.ts`. The browser UI still builds the Anthropic client; provider choice is deliberately not exposed there (gateway CORS is unverified and keys must stay local). `AgentSession` already accepts an injected client through `createModel`, so a host can pass `createModelClient(...)` without touching the loop.

## OpenAI mapping

| Our model | Chat Completions |
| --- | --- |
| `system` | first message, `role: "system"` |
| `ToolUseBlock` | assistant `tool_calls[]` (`arguments` is `JSON.stringify(input)`) |
| `ToolResultBlock` | one `role: "tool"` message per result, `Error: ` prefix when `isError` |
| tool-result images | cannot ride in a tool message: all tool messages are emitted first, then one `role: "user"` message with `image_url` data URLs, labelled `Image output of tool call <id>:`; the tool message text says the image is attached in the next message |
| `ModelToolDefinition` | `{ type: "function", function: { name, description, parameters } }` |
| `maxTokens` | `max_completion_tokens` (override with `maxTokensParam: "max_tokens"` for servers that only know the old name) |
| usage | `prompt_tokens - cached_tokens` -> `inputTokens`, `cached_tokens` -> `cacheReadTokens`, `completion_tokens` -> `outputTokens`; cache creation is never reported (0) |
| stop reason | `tool_calls` (or any tool call present) -> `tool_use`, `stop` -> `end_turn`, `length` -> `max_tokens`, else `other` |

## Differences and quirks

- **Prompt caching**: Anthropic gets explicit `cache_control` breakpoints on system, tools and the newest message. OpenAI-compatible endpoints cache automatically (if at all) and report `cached_tokens` only sometimes. Through the Surplus gateway the chat-completions path reported no cached tokens in the runs below, so token cost per step is higher than on the Anthropic path (about 2x per case on `trim-to-duration`: $0.107 vs $0.05).
- **Images**: images in tool results are delivered as a trailing user message, so the model sees them one message later than on Anthropic and not inside the tool result. `limitImages` in the loop still bounds how many are sent. If the endpoint answers 400 with an image/vision/modality complaint, the client retries once with every image replaced by `[image omitted: this model endpoint does not accept images; rely on the text description]` and stays text-only for the rest of the session, so the loop continues.
- **Tool-call arguments** arrive as a JSON string in fragments. Unparseable arguments are passed on as `{ "_unparsedArguments": "<raw>" }` so tool validation returns a readable error to the model instead of the client throwing. Empty arguments become `{}`. Missing call ids become `call_<index>`.
- **Parallel calls**: collected by `index` across chunks and returned in order; the loop already executes all calls from one turn and answers each.
- **Retries**: 429, 5xx and network errors are retried twice (0.5 s, 1 s) before surfacing; the Anthropic SDK does the same on its side. Aborts are never retried and reject with `AbortError`.
- **Errors**: `ModelError` carries the HTTP status. 401/403 messages include the status and the provider's text, redacted. `redactProviderSecrets` removes `inf_`, `sk-ant-`, `sk-` keys and the exact configured key. (`redactSecrets` in `model-client.ts` does not know plain `sk-` keys.)
- **Reasoning models** spend `max_completion_tokens` on hidden reasoning. If a model returns `finish_reason: "length"` with no text, raise `maxResponseTokens` or pass `extraBody: { reasoning_effort: "low" }`.
- **Non-streaming servers**: a `application/json` response is accepted and delivered as a single text delta.

## Verification status

Fake-fetch unit tests cover request/response/error/abort/redaction (`tests/model-client-openai.test.ts`, `tests/model-providers.test.ts`). Real runs through the Surplus gateway (`/v1/chat/completions`): see `docs/EVALS.md` "Provider-independence results". The gateway key available during development was not scoped to `gpt-5-mini`, `gpt-5.3-codex` or `mercury-2.5` (HTTP 403 "not scoped to any available provider"), so the OpenAI wire protocol was exercised with `claude-haiku-4.5` served over chat completions. No native OpenAI model has run through this client yet.

## Design note: gateways with a one-click authorize flow (not enabled)

Status: design only. Nothing in the UI, CSP or code offers a gateway today.

Idea: OpenRouter-style gateways let a browser app send the user to the gateway, have them approve, and receive a gateway key back (OAuth PKCE: redirect with a `code_challenge`, return with a `code`, exchange it for a key). That would replace "create a key in the console and paste it" with one click, and could open models from several vendors.

Why it is not enabled:

- **CSP.** `connect-src` is deliberately closed (`docs/SECURITY.md`). A gateway needs its API origin added, plus a redirect target for the authorize step. Every added origin widens where injected own-origin code could send data, so each gateway would be an explicit, reviewed `vercel.json` change, never a user-typed base URL.
- **CORS.** The Anthropic path works from a browser because Anthropic sends the permissive CORS header for `anthropic-dangerous-direct-browser-access`. A gateway has to allow browser calls for our origin and our headers (`x-api-key` or `authorization`, `anthropic-version`, streaming). That is unverified for any gateway; it must be tested per gateway before claiming support.
- **Protocol drift.** Gateways usually speak Chat Completions, not the Messages API. The OpenAI-compatible client exists (see above) but caching, image-in-tool-result and tool-call behaviour differ, and the loop's evals were scored against Anthropic.
- **Key custody.** The returned gateway key would sit in `localStorage` just like the Anthropic key, with the same residual risk, and gateway keys can carry a spend limit we cannot see or enforce. The redirect also adds a `state`/PKCE verifier to store and validate, and a callback route to harden against open redirects.
- **Trust and cost.** The user would be sending prompts, transcripts and frames to a third party we do not control, billed by that party. That must be an explicit, named choice with its own privacy copy, not a default.
- **Not a subscription workaround.** A gateway key is a paid API credential. It does not make a Claude Pro or Max login usable here; subscribers should use Claude Code through MCP (`docs/AGENT_MCP.md`).

If it is ever built: a provider registry entry with a fixed origin, a CSP change in the same PR, a CORS probe test against the real gateway, consent copy naming the third party, PKCE with a validated `state`, and eval runs per provider before it is selectable.
