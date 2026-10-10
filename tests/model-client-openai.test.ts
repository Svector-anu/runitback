import { describe, expect, it } from "vitest";
import { ModelError } from "#/app/agent/model-client";
import { OpenAIModelClient } from "#/app/agent/model-client-openai";

const BASE_REQUEST = { model: "gpt-5", system: "s", tools: [], messages: [{ role: "user" as const, content: [{ type: "text" as const, text: "hi" }] }], maxTokens: 64 };

function sseResponse(chunks: unknown[]): Response {
  const body = `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`;
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function recordingFetch(response: Response): { fetch: typeof fetch; urls: string[]; headers: Headers[]; bodies: string[] } {
  const urls: string[] = [];
  const headers: Headers[] = [];
  const bodies: string[] = [];
  const fakeFetch: typeof fetch = async (input, init) => {
    urls.push(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    headers.push(new Headers(init?.headers));
    bodies.push(typeof init?.body === "string" ? init.body : "");
    return response;
  };
  return { fetch: fakeFetch, urls, headers, bodies };
}

describe("OpenAIModelClient", () => {
  it("maps a plain-text streamed turn to a text block, end_turn, and usage", async () => {
    const response = sseResponse([
      { choices: [{ delta: { role: "assistant", content: "Hello" } }] },
      { choices: [{ delta: { content: " world" } }] },
      { choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 12, completion_tokens: 3 } },
    ]);
    const { fetch: fakeFetch, urls, headers, bodies } = recordingFetch(response);
    const deltas: string[] = [];
    const client = new OpenAIModelClient({ apiKey: "sk-test-key-12345", fetch: fakeFetch });
    const result = await client.complete({ ...BASE_REQUEST, onTextDelta: (delta) => deltas.push(delta) });

    expect(urls[0]).toBe("https://api.openai.com/v1/chat/completions");
    expect(headers[0]?.get("authorization")).toBe("Bearer sk-test-key-12345");
    expect(JSON.parse(bodies[0] ?? "{}").tools).toBeUndefined();
    expect(deltas).toEqual(["Hello", " world"]);
    expect(result.content).toEqual([{ type: "text", text: "Hello world" }]);
    expect(result.stopReason).toBe("end_turn");
    expect(result.usage).toEqual({ inputTokens: 12, outputTokens: 3, cacheReadTokens: 0, cacheCreationTokens: 0 });
  });

  it("maps a streamed tool-call turn to a ToolUseBlock with parsed input", async () => {
    const response = sseResponse([
      { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "move_clip", arguments: "" } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"id":"c1",' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"start":1.5}' } }] } }] },
      { choices: [{ delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 20, completion_tokens: 7 } },
    ]);
    const { fetch: fakeFetch } = recordingFetch(response);
    const client = new OpenAIModelClient({ apiKey: "sk-test-key-12345", baseUrl: "https://gateway.example/v1", fetch: fakeFetch });
    const result = await client.complete({
      ...BASE_REQUEST,
      tools: [{ name: "move_clip", description: "moves a clip", inputSchema: { type: "object", properties: { id: { type: "string" }, start: { type: "number" } } } }],
    });

    expect(result.content).toEqual([{ type: "tool_use", id: "call_1", name: "move_clip", input: { id: "c1", start: 1.5 } }]);
    expect(result.stopReason).toBe("tool_use");
  });

  it("maps a non-2xx response to a redacted ModelError", async () => {
    const response = new Response(JSON.stringify({ error: { message: "key sk-test-key-12345 is invalid" } }), { status: 401 });
    const { fetch: fakeFetch } = recordingFetch(response);
    const client = new OpenAIModelClient({ apiKey: "sk-test-key-12345", fetch: fakeFetch });

    const failure = await client.complete(BASE_REQUEST).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ModelError);
    expect((failure as ModelError).message).not.toContain("sk-test-key-12345");
    expect((failure as ModelError).status).toBe(401);
  });

  it("rejects with an AbortError when the signal is aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const fakeFetch: typeof fetch = async () => {
      throw new Error("network request failed");
    };
    const client = new OpenAIModelClient({ apiKey: "sk-test-key-12345", fetch: fakeFetch });

    const failure = await client.complete({ ...BASE_REQUEST, signal: controller.signal }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(DOMException);
    expect((failure as DOMException).name).toBe("AbortError");
  });
});
