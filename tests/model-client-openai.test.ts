import { describe, expect, it } from "vitest";
import { ModelError, type ModelMessage, type ModelRequest, type ModelToolDefinition } from "#/app/agent/model-client";
import { OpenAiModelClient, redactProviderSecrets } from "#/app/agent/model-client-openai";

const KEY = "sk-test-secret-key-123456";

const TOOLS: ModelToolDefinition[] = [{ name: "get_timeline", description: "Read the timeline", inputSchema: { type: "object" as const, properties: { scene: { type: "string" } } } }];

function request(messages: ModelMessage[], extra: Partial<ModelRequest> = {}): ModelRequest {
  return { model: "gpt-5-mini", system: "be brief", tools: TOOLS, messages, maxTokens: 256, ...extra };
}

const userText = (text: string): ModelMessage => ({ role: "user", content: [{ type: "text", text }] });

interface Captured { url: string; headers: Headers; body: Record<string, unknown> & { messages: Array<Record<string, unknown>> } }

function sse(...events: Array<object | "[DONE]">): Response {
  const text = events.map((e) => `data: ${e === "[DONE]" ? e : JSON.stringify(e)}\n\n`).join("");
  return new Response(text, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function script(responses: Array<() => Response | Promise<Response>>): { fetch: typeof fetch; calls: Captured[] } {
  const calls: Captured[] = [];
  let index = 0;
  const fake: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) as Captured["body"] });
    const next = responses[Math.min(index++, responses.length - 1)];
    return (next as () => Response | Promise<Response>)();
  };
  return { fetch: fake, calls };
}

const client = (fetchImpl: typeof fetch, extra: Partial<ConstructorParameters<typeof OpenAiModelClient>[0]> = {}): OpenAiModelClient =>
  new OpenAiModelClient({ apiKey: KEY, baseUrl: "https://gw.example/v1/", fetch: fetchImpl, retryDelayMs: 0, ...extra });

describe("OpenAiModelClient request mapping", () => {
  it("posts to /chat/completions with bearer auth, system message, function tools and streaming usage", async () => {
    const { fetch: f, calls } = script([() => sse({ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] }, "[DONE]")]);
    await client(f).complete(request([userText("hi")]));
    const call = calls[0] as Captured;
    expect(call.url).toBe("https://gw.example/v1/chat/completions");
    expect(call.headers.get("authorization")).toBe(`Bearer ${KEY}`);
    expect(call.body["model"]).toBe("gpt-5-mini");
    expect(call.body["max_completion_tokens"]).toBe(256);
    expect(call.body["stream"]).toBe(true);
    expect(call.body["stream_options"]).toEqual({ include_usage: true });
    expect(call.body.messages[0]).toEqual({ role: "system", content: "be brief" });
    expect(call.body.messages[1]).toEqual({ role: "user", content: [{ type: "text", text: "hi" }] });
    expect(call.body["tools"]).toEqual([{ type: "function", function: { name: "get_timeline", description: "Read the timeline", parameters: { type: "object", properties: { scene: { type: "string" } } } } }]);
  });

  it("honours maxTokensParam and extraBody", async () => {
    const { fetch: f, calls } = script([() => sse({ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] })]);
    await client(f, { maxTokensParam: "max_tokens", extraBody: { reasoning_effort: "low" } }).complete(request([userText("hi")]));
    expect(calls[0]?.body["max_tokens"]).toBe(256);
    expect(calls[0]?.body["max_completion_tokens"]).toBeUndefined();
    expect(calls[0]?.body["reasoning_effort"]).toBe("low");
  });

  it("maps assistant tool_use and tool_result blocks, with results before any trailing user text", async () => {
    const messages: ModelMessage[] = [
      userText("cut it"),
      { role: "assistant", content: [{ type: "text", text: "looking" }, { type: "tool_use", id: "a", name: "get_timeline", input: { scene: "s1" } }, { type: "tool_use", id: "b", name: "get_timeline", input: {} }] },
      { role: "user", content: [
        { type: "tool_result", toolUseId: "a", isError: false, content: [{ type: "text", text: "3 clips" }] },
        { type: "tool_result", toolUseId: "b", isError: true, content: [{ type: "text", text: "boom" }] },
        { type: "text", text: "continue" },
      ] },
    ];
    const { fetch: f, calls } = script([() => sse({ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] })]);
    await client(f).complete(request(messages));
    expect(calls[0]?.body.messages.slice(2)).toEqual([
      { role: "assistant", content: "looking", tool_calls: [
        { id: "a", type: "function", function: { name: "get_timeline", arguments: "{\"scene\":\"s1\"}" } },
        { id: "b", type: "function", function: { name: "get_timeline", arguments: "{}" } },
      ] },
      { role: "tool", tool_call_id: "a", content: "3 clips" },
      { role: "tool", tool_call_id: "b", content: "Error: boom" },
      { role: "user", content: [{ type: "text", text: "continue" }] },
    ]);
  });

  it("sends tool-result images as a following user message with data URLs", async () => {
    const messages: ModelMessage[] = [
      userText("look"),
      { role: "assistant", content: [{ type: "tool_use", id: "r1", name: "render_frame", input: {} }] },
      { role: "user", content: [{ type: "tool_result", toolUseId: "r1", isError: false, content: [{ type: "text", text: "frame at 1s" }, { type: "image", mediaType: "image/png", base64: "QUJD" }] }] },
    ];
    const { fetch: f, calls } = script([() => sse({ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] })]);
    await client(f).complete(request(messages));
    const sent = calls[0]?.body.messages ?? [];
    expect(sent[3]).toEqual({ role: "tool", tool_call_id: "r1", content: "frame at 1s\n[image 1 of this result is attached in the user message that follows]" });
    expect(sent[4]).toEqual({ role: "user", content: [
      { type: "text", text: "Image output of tool call r1:" },
      { type: "image_url", image_url: { url: "data:image/png;base64,QUJD" } },
    ] });
  });

  it("retries once without images when the provider rejects them, then stays text-only", async () => {
    const messages: ModelMessage[] = [
      userText("look"),
      { role: "assistant", content: [{ type: "tool_use", id: "r1", name: "render_frame", input: {} }] },
      { role: "user", content: [{ type: "tool_result", toolUseId: "r1", isError: false, content: [{ type: "text", text: "frame" }, { type: "image", mediaType: "image/jpeg", base64: "QUJD" }] }] },
    ];
    const { fetch: f, calls } = script([
      () => new Response(JSON.stringify({ error: { message: "This model does not support image input" } }), { status: 400, headers: { "content-type": "application/json" } }),
      () => sse({ choices: [{ delta: { content: "fine" }, finish_reason: "stop" }] }),
      () => sse({ choices: [{ delta: { content: "again" }, finish_reason: "stop" }] }),
    ]);
    const c = client(f);
    const first = await c.complete(request(messages));
    expect(first.content).toEqual([{ type: "text", text: "fine" }]);
    expect(JSON.stringify(calls[0]?.body)).toContain("image_url");
    expect(JSON.stringify(calls[1]?.body)).not.toContain("image_url");
    expect(JSON.stringify(calls[1]?.body)).toContain("image omitted");
    await c.complete(request(messages));
    expect(calls).toHaveLength(3);
    expect(JSON.stringify(calls[2]?.body)).not.toContain("image_url");
  });
});

describe("OpenAiModelClient response mapping", () => {
  it("streams text deltas and maps usage with cached tokens", async () => {
    const deltas: string[] = [];
    const { fetch: f } = script([() => sse(
      { choices: [{ delta: { content: "Hel" } }] },
      { choices: [{ delta: { content: "lo" }, finish_reason: "stop" }] },
      { choices: [], usage: { prompt_tokens: 1000, completion_tokens: 40, prompt_tokens_details: { cached_tokens: 600 } } },
      "[DONE]",
    )]);
    const response = await client(f).complete(request([userText("hi")], { onTextDelta: (d) => deltas.push(d) }));
    expect(deltas).toEqual(["Hel", "lo"]);
    expect(response.content).toEqual([{ type: "text", text: "Hello" }]);
    expect(response.stopReason).toBe("end_turn");
    expect(response.usage).toEqual({ inputTokens: 400, outputTokens: 40, cacheReadTokens: 600, cacheCreationTokens: 0 });
  });

  it("assembles parallel tool calls from fragmented argument deltas", async () => {
    const { fetch: f } = script([() => sse(
      { choices: [{ delta: { content: "on it", tool_calls: [{ index: 0, id: "c0", function: { name: "get_timeline", arguments: "{\"sc" } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 1, id: "c1", function: { name: "get_timeline", arguments: "" } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "ene\":\"s1\"}" } }] } }] },
      { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
    )]);
    const response = await client(f).complete(request([userText("go")]));
    expect(response.stopReason).toBe("tool_use");
    expect(response.content).toEqual([
      { type: "text", text: "on it" },
      { type: "tool_use", id: "c0", name: "get_timeline", input: { scene: "s1" } },
      { type: "tool_use", id: "c1", name: "get_timeline", input: {} },
    ]);
    expect(response.usage).toEqual({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 });
  });

  it("keeps unparseable arguments visible and invents ids when the provider omits them", async () => {
    const { fetch: f } = script([() => sse({ choices: [{ delta: { tool_calls: [{ index: 0, function: { name: "get_timeline", arguments: "{oops" } }] }, finish_reason: "stop" }] })]);
    const response = await client(f).complete(request([userText("go")]));
    expect(response.content).toEqual([{ type: "tool_use", id: "call_0", name: "get_timeline", input: { _unparsedArguments: "{oops" } }]);
    expect(response.stopReason).toBe("tool_use");
  });

  it("maps length to max_tokens and unknown reasons to other", async () => {
    const lengthRun = script([() => sse({ choices: [{ delta: { content: "cut" }, finish_reason: "length" }] })]);
    expect((await client(lengthRun.fetch).complete(request([userText("x")]))).stopReason).toBe("max_tokens");
    const other = script([() => sse({ choices: [{ delta: { content: "x" }, finish_reason: "content_filter" }] })]);
    expect((await client(other.fetch).complete(request([userText("x")]))).stopReason).toBe("other");
  });

  it("accepts a non-streaming JSON completion", async () => {
    const { fetch: f } = script([() => new Response(JSON.stringify({
      choices: [{ message: { content: "plain", tool_calls: [{ id: "t", function: { name: "get_timeline", arguments: "{}" } }] }, finish_reason: "tool_calls" }],
      usage: { prompt_tokens: 10, completion_tokens: 2 },
    }), { status: 200, headers: { "content-type": "application/json" } })]);
    const deltas: string[] = [];
    const response = await client(f).complete(request([userText("x")], { onTextDelta: (d) => deltas.push(d) }));
    expect(deltas).toEqual(["plain"]);
    expect(response.content).toEqual([{ type: "text", text: "plain" }, { type: "tool_use", id: "t", name: "get_timeline", input: {} }]);
    expect(response.usage.inputTokens).toBe(10);
  });
});

describe("OpenAiModelClient errors", () => {
  const failing = (status: number, message: string): (() => Response) => () =>
    new Response(JSON.stringify({ error: { message } }), { status, headers: { "content-type": "application/json" } });

  it("401/403 include the status and a redacted detail", async () => {
    for (const status of [401, 403]) {
      const { fetch: f } = script([failing(status, `Incorrect API key provided: ${KEY} and inf_abc123 and sk-proj-abcdefgh1234`)]);
      const error = await client(f).complete(request([userText("x")])).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ModelError);
      const modelError = error as ModelError;
      expect(modelError.status).toBe(status);
      expect(modelError.message).toContain(`HTTP ${status}`);
      expect(modelError.message).not.toContain(KEY);
      expect(modelError.message).not.toContain("inf_abc123");
      expect(modelError.message).not.toContain("sk-proj");
      expect(modelError.message).toContain("[redacted]");
    }
  });

  it("retries 429 then surfaces a rate-limit error", async () => {
    const { fetch: f, calls } = script([failing(429, "slow down")]);
    const error = (await client(f).complete(request([userText("x")])).catch((e: unknown) => e)) as ModelError;
    expect(error.status).toBe(429);
    expect(error.message).toMatch(/rate limit/i);
    expect(calls).toHaveLength(3);
  });

  it("recovers when a retry succeeds after a 5xx", async () => {
    const { fetch: f, calls } = script([failing(503, "down"), () => sse({ choices: [{ delta: { content: "back" }, finish_reason: "stop" }] })]);
    const response = await client(f).complete(request([userText("x")]));
    expect(response.content).toEqual([{ type: "text", text: "back" }]);
    expect(calls).toHaveLength(2);
  });

  it("surfaces persistent 5xx as unavailable with the status", async () => {
    const { fetch: f } = script([failing(502, "bad gateway")]);
    const error = (await client(f, { maxRetries: 1 }).complete(request([userText("x")])).catch((e: unknown) => e)) as ModelError;
    expect(error.status).toBe(502);
    expect(error.message).toMatch(/unavailable/);
  });

  it("does not retry other 4xx and keeps the redacted body", async () => {
    const { fetch: f, calls } = script([failing(400, "bad schema")]);
    const error = (await client(f).complete(request([userText("x")])).catch((e: unknown) => e)) as ModelError;
    expect(error.status).toBe(400);
    expect(error.message).toContain("bad schema");
    expect(calls).toHaveLength(1);
  });

  it("wraps network failures with redaction", async () => {
    const f: typeof fetch = async () => { throw new TypeError(`connect failed for ${KEY}`); };
    const error = (await client(f, { maxRetries: 0 }).complete(request([userText("x")])).catch((e: unknown) => e)) as ModelError;
    expect(error).toBeInstanceOf(ModelError);
    expect(error.message).not.toContain(KEY);
  });

  it("rejects with an AbortError when the signal aborts", async () => {
    const controller = new AbortController();
    const f: typeof fetch = (_input, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    });
    const pending = client(f).complete(request([userText("x")], { signal: controller.signal }));
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });

  it("rejects immediately when already aborted", async () => {
    const { fetch: f, calls } = script([() => sse({ choices: [] })]);
    const controller = new AbortController();
    controller.abort();
    await expect(client(f).complete(request([userText("x")], { signal: controller.signal }))).rejects.toMatchObject({ name: "AbortError" });
    expect(calls).toHaveLength(0);
  });
});

describe("redactProviderSecrets", () => {
  it("removes inf_, sk-ant-, sk- keys and the exact configured key", () => {
    const text = "a inf_admin_xyz123 b sk-ant-api03-abcdefg c sk-proj-AbCd1234_x d custom-key-value-9";
    const out = redactProviderSecrets(text, "custom-key-value-9");
    expect(out).toBe("a [redacted] b [redacted] c [redacted] d [redacted]");
  });
});
