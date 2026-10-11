import { describe, expect, it } from "vitest";
import { createAgentTools, type AgentTool } from "#/engine/agent";
import {
  AnthropicModelClient, ScriptedModelClient, type AssistantBlock, type ModelMessage, type ModelRequest, type ToolResultBlock, type UserBlock,
} from "#/app/agent/model-client";
import { toWireMessages } from "#/app/agent/model-client-openai";
import { COMPACTION_STEP_QUANTUM, KEEP_RECENT_STEPS, compactHistory, limitImages, runAgent } from "#/app/agent/loop";
import { ASSETS } from "./agent-harness";
import { makeEditor } from "./helpers";

const DUMP = "x".repeat(5000);
const FRAME = "A".repeat(20_000);

const use = (id: string, name: string): AssistantBlock => ({ type: "tool_use", id, name, input: {} });

function resultBlock(id: string, kind: "dump" | "frame" | "small"): ToolResultBlock {
  if (kind === "small") return { type: "tool_result", toolUseId: id, isError: false, content: [{ type: "text", text: "Placed 3 clips." }] };
  if (kind === "dump") return { type: "tool_result", toolUseId: id, isError: false, content: [{ type: "text", text: `Analysis of a1\n${DUMP}` }] };
  return { type: "tool_result", toolUseId: id, isError: false, content: [{ type: "text", text: "Rendered frame" }, { type: "image", mediaType: "image/jpeg", base64: FRAME }] };
}

/** `turns` user requests, each with `steps` tool steps that cycle dump, frame, small results, then a final answer. */
function longConversation(input: { turns: number; steps: number }): ModelMessage[] {
  const kinds = ["dump", "frame", "small"] as const;
  const messages: ModelMessage[] = [];
  let id = 0;
  for (let t = 0; t < input.turns; t++) {
    messages.push({ role: "user", content: [{ type: "text", text: `request ${t}` }] });
    for (let s = 0; s < input.steps; s++) {
      const callId = `call-${++id}`;
      const kind = kinds[s % kinds.length] as (typeof kinds)[number];
      messages.push({ role: "assistant", content: [{ type: "text", text: "next" }, use(callId, kind === "frame" ? "render_frame" : kind === "dump" ? "analyze_media" : "cut_to_moments")] });
      messages.push({ role: "user", content: [resultBlock(callId, kind)] });
    }
    messages.push({ role: "assistant", content: [{ type: "text", text: `done ${t}` }] });
  }
  return messages;
}

/** Character count as a token proxy: text plus base64 payloads. */
function chars(messages: ReadonlyArray<ModelMessage>): number {
  const block = (b: UserBlock | AssistantBlock): number => {
    if (b.type === "text") return b.text.length;
    if (b.type === "image") return b.base64.length;
    if (b.type === "tool_use") return JSON.stringify(b.input).length + b.name.length;
    return b.content.reduce((n, c) => n + block(c), 0);
  };
  return messages.reduce((n, m) => n + (m.content as Array<UserBlock | AssistantBlock>).reduce((k, b) => k + block(b), 0), 0);
}

function assertPaired(messages: ReadonlyArray<ModelMessage>): void {
  messages.forEach((message, i) => {
    if (message.role !== "assistant") return;
    const ids = message.content.flatMap((b) => (b.type === "tool_use" ? [b.id] : []));
    if (ids.length === 0) return;
    const next = messages[i + 1];
    expect(next?.role, `message ${i} tool_use must be answered by the next user message`).toBe("user");
    const answered = next && next.role === "user" ? next.content.flatMap((b) => (b.type === "tool_result" ? [b.toolUseId] : [])) : [];
    expect(answered).toEqual(ids);
  });
}

const resultsOf = (messages: ReadonlyArray<ModelMessage>): ToolResultBlock[] =>
  messages.flatMap((m) => (m.role === "user" ? m.content.filter((b): b is ToolResultBlock => b.type === "tool_result") : []));
const isStub = (block: ToolResultBlock): boolean => block.content.length === 1 && block.content[0]?.type === "text" && block.content[0].text.startsWith("[result omitted:");

describe("compactHistory", () => {
  const conversation = longConversation({ turns: 3, steps: 14 });

  it("shrinks a long conversation a lot while keeping every tool_use paired with its tool_result", () => {
    const before = chars(limitImages(conversation));
    const compacted = compactHistory(conversation);
    const after = chars(limitImages(compacted));
    expect(after).toBeLessThan(before * 0.5);
    assertPaired(compacted);
    expect(resultsOf(compacted).map((r) => r.toolUseId)).toEqual(resultsOf(conversation).map((r) => r.toolUseId));
    expect(compacted).toHaveLength(conversation.length);
  });

  it("stubs stale bulky results with a readable marker and leaves small ones and the input alone", () => {
    const snapshot = JSON.stringify(conversation);
    const compacted = compactHistory(conversation);
    expect(JSON.stringify(conversation)).toBe(snapshot);
    const stubs = resultsOf(compacted).filter(isStub);
    expect(stubs.length).toBeGreaterThan(0);
    const text = (stubs[0]?.content[0] as { text: string }).text;
    expect(text).toMatch(/^\[result omitted: (analyze_media|render_frame), /);
    expect(resultsOf(compacted).filter((r) => textOf(r) === "Placed 3 clips.")).toHaveLength(resultsOf(conversation).filter((r) => textOf(r) === "Placed 3 clips.").length);
  });

  it("stubs every bulky result of earlier requests and keeps the newest steps of the current one in full", () => {
    const compacted = compactHistory(conversation);
    const goalIndexes = compacted.flatMap((m, i) => (m.role === "user" && m.content[0]?.type === "text" ? [i] : []));
    const lastGoal = goalIndexes[goalIndexes.length - 1] as number;
    for (const [i, m] of compacted.entries()) {
      if (m.role !== "user") continue;
      for (const r of m.content.filter((b): b is ToolResultBlock => b.type === "tool_result")) {
        const bulky = textOf(r).length > 600 || r.content.some((c) => c.type === "image");
        if (i < lastGoal && bulky) expect(isStub(r), `previous request, message ${i}`).toBe(true);
      }
    }
    const current = compacted.slice(lastGoal);
    const recent = resultsOf(current.slice(-2 * KEEP_RECENT_STEPS - 1));
    expect(recent.some(isStub)).toBe(false);
  });

  it("never touches the latest step's results, whatever the step count", () => {
    for (let steps = 1; steps <= 20; steps++) {
      const partial = longConversation({ turns: 2, steps }).slice(0, -1);
      const compacted = compactHistory(partial);
      expect(compacted[compacted.length - 1]).toEqual(partial[partial.length - 1]);
      assertPaired(compacted);
    }
  });

  it("only changes the stubbed prefix every few steps, so the cached prefix survives between them", () => {
    const base = longConversation({ turns: 1, steps: 30 }).slice(0, -1);
    let changes = 0;
    let previous = compactHistory(base.slice(0, 2));
    for (let n = 4; n <= base.length; n += 2) {
      const next = compactHistory(base.slice(0, n));
      const stable = previous.every((m, i) => JSON.stringify(m) === JSON.stringify(next[i]));
      if (!stable) changes++;
      previous = next;
    }
    const steps = base.length / 2;
    expect(changes).toBeLessThanOrEqual(Math.ceil(steps / COMPACTION_STEP_QUANTUM) + 1);
  });

  it("maps to valid OpenAI wire messages", () => {
    const wire = toWireMessages("system", limitImages(compactHistory(conversation)), true);
    wire.forEach((m, i) => {
      if (m.role !== "assistant" || !("tool_calls" in m) || !m.tool_calls) return;
      const following = wire.slice(i + 1, i + 1 + m.tool_calls.length);
      expect(following.map((w) => (w.role === "tool" ? w.tool_call_id : null))).toEqual(m.tool_calls.map((c) => c.id));
    });
    const toolIds = wire.flatMap((w) => (w.role === "tool" ? [w.tool_call_id] : []));
    expect(new Set(toolIds).size).toBe(toolIds.length);
  });

  it("maps to a valid Anthropic request body that keeps the cache breakpoints", async () => {
    let body: { system: Array<{ cache_control?: unknown }>; tools: Array<{ cache_control?: unknown }>; messages: Array<{ role: string; content: Array<Record<string, unknown>> }> } | undefined;
    const fakeFetch: typeof fetch = async (_input, init) => {
      body = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "stop" } }), { status: 400, headers: { "content-type": "application/json" } });
    };
    const client = new AnthropicModelClient({ apiKey: "sk-ant-test-12345", fetch: fakeFetch });
    const tail: ModelMessage[] = [...conversation.slice(0, -1)];
    await client.complete({
      model: "claude-sonnet-5-5", system: "s", maxTokens: 16, messages: limitImages(compactHistory(tail)),
      tools: [{ name: "a", description: "a", inputSchema: { type: "object" } }, { name: "b", description: "b", inputSchema: { type: "object" } }],
    }).catch(() => undefined);
    expect(body).toBeDefined();
    if (!body) return;
    expect(body.system[0]?.cache_control).toBeDefined();
    expect(body.tools[1]?.cache_control).toBeDefined();
    const wire = body.messages;
    wire.forEach((m, i) => {
      if (m.role !== "assistant") return;
      const ids = m.content.flatMap((b) => (b.type === "tool_use" ? [b.id] : []));
      if (ids.length === 0) return;
      const answered = (wire[i + 1]?.content ?? []).flatMap((b) => (b.type === "tool_result" ? [b.tool_use_id] : []));
      expect(answered).toEqual(ids);
    });
    const lastBlocks = wire[wire.length - 1]?.content ?? [];
    expect(lastBlocks[lastBlocks.length - 1]?.cache_control).toBeDefined();
  });
});

const textOf = (block: ToolResultBlock): string => block.content.map((c) => (c.type === "text" ? c.text : "<image>")).join("\n");

describe("runAgent sends compacted history", () => {
  it("stubs old analysis dumps in later requests but never the newest results", async () => {
    const bigTool: AgentTool = {
      name: "analyze_media", description: "fake", inputSchema: { type: "object", properties: {} }, readOnly: true,
      run: () => ({ ok: true, summary: `Analysis\n${DUMP}` }),
    };
    const registry = new Map(createAgentTools());
    registry.set(bigTool.name, bigTool);
    const steps = 14;
    const requests: ModelRequest[] = [];
    const turns = Array.from({ length: steps }, (_, i) => (request: ModelRequest) => {
      requests.push(request);
      return { content: [use(`c${i}`, "analyze_media")] };
    });
    const model = new ScriptedModelClient([...turns, (request: ModelRequest) => { requests.push(request); return { content: [{ type: "text" as const, text: "ok" }] }; }]);
    const { editor } = makeEditor({ assets: ASSETS });
    const result = await runAgent({ goal: "analyze", history: [], model, tools: registry, editor, maxSteps: 30 });
    expect(result.status).toBe("done");

    const last = requests[requests.length - 1] as ModelRequest;
    const sent = resultsOf(last.messages);
    expect(sent.at(-1) && isStub(sent.at(-1) as ToolResultBlock)).toBe(false);
    expect(sent.filter(isStub).length).toBeGreaterThan(0);
    expect(chars(last.messages)).toBeLessThan(chars(result.history) * 0.6);
    assertPaired(last.messages);
    expect(resultsOf(result.history).some(isStub), "the stored history stays complete").toBe(false);
  });
});
