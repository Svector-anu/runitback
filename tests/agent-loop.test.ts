import { describe, expect, it } from "vitest";
import { createAgentTools, type AgentTool, type AgentToolRegistry } from "#/engine/agent";
import { Editor } from "#/engine/editor";
import {
  ScriptedModelClient, ModelError, type AssistantBlock, type ModelMessage, type ModelRequest, type ToolResultBlock,
} from "#/app/agent/model-client";
import { MAX_IMAGES_IN_CONTEXT, limitImages, runAgent, type AgentEvent } from "#/app/agent/loop";
import { ASSETS } from "./agent-harness";
import { makeEditor } from "./helpers";

const PIXEL = "/9j/4AAQSkZJRgABAQEASABIAAD/2wBD";

const use = (id: string, name: string, input: unknown = {}): AssistantBlock => ({ type: "tool_use", id, name, input });
const say = (text: string): AssistantBlock => ({ type: "text", text });

function lastResults(request: ModelRequest): ToolResultBlock[] {
  const last = request.messages[request.messages.length - 1] as ModelMessage;
  return last.role === "user" ? last.content.filter((b): b is ToolResultBlock => b.type === "tool_result") : [];
}

const textOf = (block: ToolResultBlock): string => block.content.map((c) => (c.type === "text" ? c.text : "<image>")).join("\n");

function registryWith(extra: AgentTool[] = []): AgentToolRegistry {
  const registry = new Map(createAgentTools());
  for (const tool of extra) registry.set(tool.name, tool);
  return registry;
}

const frameTool: AgentTool = {
  name: "render_frame",
  description: "fake renderer",
  inputSchema: { type: "object", properties: { time: { type: "number" } } },
  readOnly: true,
  run: () => ({ ok: true, summary: "Rendered frame at 1.00s", images: [{ mediaType: "image/jpeg", base64: PIXEL, caption: "frame at 1.00s" }] }),
};

const mainCount = (editor: Editor): number => {
  const doc = editor.getState().doc;
  return doc.scenes.flatMap((s) => s.tracks.main.elements).length;
};

function setup(extra: AgentTool[] = []) {
  const { editor } = makeEditor({ assets: ASSETS });
  const events: AgentEvent[] = [];
  const base = { editor, tools: registryWith(extra), onEvent: (e: AgentEvent) => events.push(e) };
  return { editor, events, base };
}

describe("runAgent", () => {
  it("executes tool_use, feeds results back and finishes with the model's summary", async () => {
    const { editor, events, base } = setup();
    const model = new ScriptedModelClient([
      { content: [say("Checking assets."), use("t1", "list_assets")] },
      (request) => {
        const text = textOf(lastResults(request)[0] as ToolResultBlock);
        expect(text).toContain("a1");
        return { content: [use("t2", "insert_media", { assetId: "a1" })] };
      },
      { content: [say("Added a1 to the timeline.")], usage: { inputTokens: 10, outputTokens: 5 } },
    ]);
    const result = await runAgent({ ...base, model, goal: "put the first clip on the timeline", history: [] });

    expect(result.status).toBe("done");
    expect(result.finalText).toBe("Added a1 to the timeline.");
    expect(result.steps).toBe(3);
    expect(result.changed).toBe(true);
    expect(mainCount(editor)).toBe(1);
    expect(result.usage.inputTokens).toBe(10);
    expect(result.history.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant", "user", "assistant"]);
    expect(events.filter((e) => e.type === "tool_call").map((e) => e.type === "tool_call" && e.name)).toEqual(["list_assets", "insert_media"]);
    expect(events.at(-1)).toMatchObject({ type: "done", status: "done" });
    expect(model.requests[0]?.tools.map((t) => t.name)).toContain("insert_media");
    expect(model.requests[0]?.system).toContain("Verify");
  });

  it("returns image results to the model as image blocks and emits image events", async () => {
    const { base, events } = setup([frameTool]);
    const model = new ScriptedModelClient([
      { content: [use("t1", "render_frame", { time: 1 })] },
      (request) => {
        const block = lastResults(request)[0] as ToolResultBlock;
        expect(block.isError).toBe(false);
        expect(block.content.some((c) => c.type === "image" && c.base64 === PIXEL)).toBe(true);
        return { content: [say("Frame looks right.")] };
      },
    ]);
    const result = await runAgent({ ...base, model, goal: "look", history: [] });
    expect(result.status).toBe("done");
    expect(events.find((e) => e.type === "image")).toMatchObject({ type: "image", caption: "frame at 1.00s", mediaType: "image/jpeg" });
  });

  it("reports tool errors as is_error results and lets the model recover", async () => {
    const { editor, base } = setup();
    const model = new ScriptedModelClient([
      { content: [use("t1", "insert_media", { assetId: "nope" })] },
      (request) => {
        const block = lastResults(request)[0] as ToolResultBlock;
        expect(block.isError).toBe(true);
        expect(textOf(block)).toMatch(/nope/);
        return { content: [use("t2", "insert_media", { assetId: "a2" })] };
      },
      { content: [say("Recovered.")] },
    ]);
    const result = await runAgent({ ...base, model, goal: "add a clip", history: [] });
    expect(result.status).toBe("done");
    expect(mainCount(editor)).toBe(1);
  });

  it("unknown tools become error results instead of crashing the run", async () => {
    const { base } = setup();
    const model = new ScriptedModelClient([
      { content: [use("t1", "teleport")] },
      (request) => {
        expect((lastResults(request)[0] as ToolResultBlock).isError).toBe(true);
        return { content: [say("Sorry.")] };
      },
    ]);
    expect((await runAgent({ ...base, model, goal: "x", history: [] })).status).toBe("done");
  });

  it("abort rolls the document and history back exactly", async () => {
    const { editor, base } = setup();
    const controller = new AbortController();
    const before = editor.getState().doc;
    const model = new ScriptedModelClient([
      { content: [use("t1", "insert_media", { assetId: "a1" })] },
      () => {
        controller.abort();
        return { content: [use("t2", "insert_media", { assetId: "a2" })] };
      },
    ]);
    const history: ModelMessage[] = [];
    const result = await runAgent({ ...base, model, goal: "go", history, signal: controller.signal });
    expect(result.status).toBe("aborted");
    expect(result.changed).toBe(false);
    expect(editor.getState().doc).toBe(before);
    expect(editor.getState().canUndo).toBe(false);
    expect(result.history).toBe(history);
    expect(editor.inTransaction).toBe(false);
  });

  it("a model failure rolls back and never leaks the API key", async () => {
    const { editor, base } = setup();
    const before = editor.getState().doc;
    const model = new ScriptedModelClient([
      { content: [use("t1", "insert_media", { assetId: "a1" })] },
      () => { throw new ModelError("request failed for key sk-ant-api03-SECRETSECRET123"); },
    ]);
    const result = await runAgent({ ...base, model, goal: "go", history: [] });
    expect(result.status).toBe("error");
    expect(result.error).not.toContain("SECRETSECRET");
    expect(editor.getState().doc).toBe(before);
  });

  it("stops at the step budget but keeps the edits", async () => {
    const { editor, base } = setup();
    const model = new ScriptedModelClient([
      { content: [use("t1", "insert_media", { assetId: "a1" })] },
      { content: [use("t2", "get_project")] },
      { content: [use("t3", "get_project")] },
    ]);
    const result = await runAgent({ ...base, model, goal: "loop", history: [], maxSteps: 2 });
    expect(result.status).toBe("max_steps");
    expect(result.steps).toBe(2);
    expect(model.remaining).toBe(1);
    expect(result.changed).toBe(true);
    expect(mainCount(editor)).toBe(1);
    expect(result.history.at(-1)?.role).toBe("assistant");
  });

  it("stops at the token budget", async () => {
    const { base } = setup();
    const model = new ScriptedModelClient([
      { content: [use("t1", "get_project")], usage: { inputTokens: 600, outputTokens: 100 } },
      { content: [say("never reached")] },
    ]);
    const result = await runAgent({ ...base, model, goal: "x", history: [], tokenBudget: 500 });
    expect(result.status).toBe("token_budget");
    expect(model.remaining).toBe(1);
  });

  it("one undo reverts everything the agent did in a request", async () => {
    const { editor, base } = setup();
    const before = editor.getState().doc;
    const model = new ScriptedModelClient([
      { content: [use("t1", "insert_media", { assetId: "a1" }), use("t2", "insert_media", { assetId: "a2" })] },
      { content: [use("t3", "insert_text", { text: "Hello", start: 1 }), use("t4", "split", { at: 4 })] },
      { content: [say("Done.")] },
    ]);
    const result = await runAgent({ ...base, model, goal: "build", history: [] });
    expect(result.status).toBe("done");
    expect(editor.getState().doc).not.toBe(before);
    expect(result.docAfter).toBe(editor.getState().doc);

    expect(editor.undo()).toBe(true);
    expect(editor.getState().doc).toBe(before);
    expect(editor.getState().canUndo).toBe(false);
  });

  it("a request that changes nothing leaves undo history alone", async () => {
    const { editor, base } = setup();
    const model = new ScriptedModelClient([{ content: [use("t1", "get_timeline")] }, { content: [say("Empty timeline.")] }]);
    const result = await runAgent({ ...base, model, goal: "look", history: [] });
    expect(result.changed).toBe(false);
    expect(editor.getState().canUndo).toBe(false);
  });

  it("runs the calls of one turn strictly one after another", async () => {
    let active = 0;
    let maxActive = 0;
    const slow: AgentTool = {
      name: "slow", description: "slow", inputSchema: { type: "object", properties: {} }, readOnly: true,
      async run() {
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise((r) => setTimeout(r, 5));
        active--;
        return { ok: true, summary: "slept" };
      },
    };
    const { base } = setup([slow]);
    const model = new ScriptedModelClient([
      { content: [use("t1", "slow"), use("t2", "slow"), use("t3", "slow")] },
      { content: [say("ok")] },
    ]);
    await runAgent({ ...base, model, goal: "x", history: [] });
    expect(maxActive).toBe(1);
  });

  it("refuses a second concurrent run on the same editor without touching it", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => { release = r; });
    const blocker: AgentTool = {
      name: "blocker", description: "waits", inputSchema: { type: "object", properties: {} }, readOnly: true,
      async run() { await gate; return { ok: true, summary: "released" }; },
    };
    const { editor, base } = setup([blocker]);
    const first = runAgent({ ...base, goal: "first", history: [], model: new ScriptedModelClient([{ content: [use("t1", "blocker")] }, { content: [say("first done")] }]) });
    await Promise.resolve();

    const secondModel = new ScriptedModelClient([{ content: [say("should not run")] }]);
    const second = await runAgent({ ...base, goal: "second", history: [], model: secondModel });
    expect(second.status).toBe("busy");
    expect(secondModel.requests).toHaveLength(0);
    expect(editor.inTransaction).toBe(true);

    release();
    expect((await first).status).toBe("done");
    expect(editor.inTransaction).toBe(false);
    const third = await runAgent({ ...base, goal: "third", history: [], model: new ScriptedModelClient([{ content: [say("fine")] }]) });
    expect(third.status).toBe("done");
  });

  it("carries the conversation into the next request", async () => {
    const { base } = setup();
    const first = await runAgent({ ...base, goal: "one", history: [], model: new ScriptedModelClient([{ content: [say("A")] }]) });
    const model = new ScriptedModelClient([{ content: [say("B")] }]);
    await runAgent({ ...base, model, goal: "two", history: first.history });
    expect(model.requests[0]?.messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
  });
});

describe("limitImages", () => {
  it("keeps only the newest images and never mutates the input", () => {
    const toolMessage = (n: number): ModelMessage => ({
      role: "user",
      content: [{ type: "tool_result", toolUseId: `t${n}`, isError: false, content: [{ type: "text", text: "ok" }, { type: "image", mediaType: "image/jpeg", base64: `img${n}` }] }],
    });
    const messages = Array.from({ length: MAX_IMAGES_IN_CONTEXT + 3 }, (_, i) => toolMessage(i));
    const limited = limitImages(messages);
    const images = limited.flatMap((m) => (m.role === "user" ? m.content : [])).flatMap((b) => (b.type === "tool_result" ? b.content : [])).filter((c) => c.type === "image");
    expect(images).toHaveLength(MAX_IMAGES_IN_CONTEXT);
    expect(images.at(-1)).toMatchObject({ base64: `img${MAX_IMAGES_IN_CONTEXT + 2}` });
    expect(JSON.stringify(messages)).toContain("img0");
    expect(JSON.stringify(limited)).not.toContain("img0");
  });
});
