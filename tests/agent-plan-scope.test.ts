import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { callTool, createAgentTools, isSingleTargetedEdit, planScopeViolation, type AgentTool, type Plan } from "#/engine/agent";
import type { Editor } from "#/engine/editor";
import { runAgent, type PlanDecision, type PlanningOptions } from "#/app/agent/loop";
import { ScriptedModelClient, type AssistantBlock, type ModelMessage, type ModelRequest, type ToolResultBlock } from "#/app/agent/model-client";
import { ASSETS } from "./agent-harness";
import { makeEditor } from "./helpers";

const use = (id: string, name: string, input: unknown = {}): AssistantBlock => ({ type: "tool_use", id, name, input });
const say = (text: string): AssistantBlock => ({ type: "text", text });
const tools = createAgentTools();
const tool = (name: string): AgentTool => {
  const found = tools.get(name);
  if (!found) throw new Error(`no tool ${name}`);
  return found;
};

const plan = (steps: Array<{ tools: string[]; targets?: string[] }>): Plan => ({
  summary: "s",
  steps: steps.map((s) => ({ intent: "i", tools: s.tools, targets: s.targets ?? [], check: "c" })),
});

describe("isSingleTargetedEdit", () => {
  it.each([
    ["delete", { elementIds: ["e1"] }],
    ["split", { at: 2, elementIds: ["e1"] }],
    ["move", { elementIds: ["e1"], delta: 1 }],
    ["trim", { elementId: "e1", start: 1 }],
    ["set_params", { elementId: "e1", params: { opacity: 0.5 } }],
    ["set_params", { elementIds: ["e1"], params: { opacity: 0.5 } }],
    ["insert_media", { assetId: "a1" }],
    ["insert_text", { text: "hi" }],
    ["set_track", { trackId: "t", muted: true }],
    ["add_bookmark", { time: 1 }],
  ])("allows %s %j", (name, args) => {
    expect(isSingleTargetedEdit(tool(name), args)).toBe(true);
  });

  it.each([
    ["delete", { elementIds: ["e1", "e2"] }],
    ["delete", { elementIds: ["e1"], ripple: true }],
    ["delete", { elementIds: [] }],
    ["move", { elementIds: ["e1", "e2"], delta: 1 }],
    ["duplicate", { elementIds: ["e1", "e2"] }],
    ["split", { at: 2 }],
    ["split", { at: 2, elementIds: ["e1", "e2"] }],
    ["set_params", { elementIds: ["e1", "e2"], params: {} }],
    ["delete_track", { trackId: "t" }],
    ["set_project", { fps: 24 }],
    ["import_captions", { srt: "x" }],
    ["undo", {}],
    ["redo", {}],
  ])("treats %s %j as planned-only", (name, args) => {
    expect(isSingleTargetedEdit(tool(name), args)).toBe(false);
  });

  it("treats non-object args like an empty call", () => {
    expect(isSingleTargetedEdit(tool("split"), null)).toBe(false);
    expect(isSingleTargetedEdit(tool("insert_media"), "x")).toBe(true);
  });
});

describe("planScopeViolation", () => {
  const existing = new Set(["e1", "e2", "e12", "t1"]);
  const check = (p: Plan, name: string, args: unknown): string | null =>
    planScopeViolation({ plan: p, tool: tool(name), args, existingIds: existing });

  it("refuses a tool no step lists", () => {
    const reason = check(plan([{ tools: ["split"] }]), "delete", { elementIds: ["e1"] });
    expect(reason).toMatch(/not in the approved plan: propose an updated plan/);
    expect(reason).toContain('"delete"');
  });

  it("allows listed tools when no targets were declared", () => {
    expect(check(plan([{ tools: ["delete"] }]), "delete", { elementIds: ["e1", "e2"] })).toBeNull();
  });

  it("refuses existing elements the plan did not name, matching ids exactly", () => {
    const p = plan([{ tools: ["delete"], targets: ["clip e1 (0-4s)"] }]);
    expect(check(p, "delete", { elementIds: ["e1"] })).toBeNull();
    expect(check(p, "delete", { elementIds: ["e1", "e2"] })).toMatch(/not in the approved plan: propose an updated plan/);
    expect(check(plan([{ tools: ["delete"], targets: ["clip e12"] }]), "delete", { elementIds: ["e1"] })).toMatch(/e1/);
  });

  it("allows ids created after approval", () => {
    const p = plan([{ tools: ["split", "move"], targets: ["clip e1"] }]);
    expect(check(p, "move", { elementIds: ["brand-new-right-half"], delta: 1 })).toBeNull();
  });

  it("binds track targets of track tools", () => {
    const p = plan([{ tools: ["delete_track"], targets: ["clip e1"] }]);
    expect(check(p, "delete_track", { trackId: "t1" })).toMatch(/t1/);
    expect(check(plan([{ tools: ["delete_track"], targets: ["track t1"] }]), "delete_track", { trackId: "t1" })).toBeNull();
  });

  it("binds a cut time to the declared time ranges", () => {
    const p = plan([{ tools: ["split"], targets: ["clip e1 (0-4.5s)"] }]);
    expect(check(p, "split", { at: 4, elementIds: ["e1"] })).toBeNull();
    expect(check(p, "split", { at: 9, elementIds: ["e1"] })).toMatch(/9s/);
  });

  it("does not bind what free text cannot express", () => {
    const p = plan([{ tools: ["delete"], targets: ["the intro section"] }]);
    expect(check(p, "delete", { elementIds: ["e2"] })).toBeNull();
  });
});

describe("the plan gate in the loop", () => {
  const textOf = (block: ToolResultBlock): string => block.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
  const results = (request: ModelRequest): ToolResultBlock[] => {
    const last = request.messages[request.messages.length - 1] as ModelMessage;
    return last.role === "user" ? last.content.filter((b): b is ToolResultBlock => b.type === "tool_result") : [];
  };
  const ids = (editor: Editor): string[] =>
    editor.getState().doc.scenes.flatMap((s) => [...s.tracks.overlay, s.tracks.main, ...s.tracks.audio].flatMap((t) => t.elements.map((e) => e.id)));
  const approve: PlanningOptions = { mode: "ask", decide: async (): Promise<PlanDecision> => ({ kind: "approve" }) };

  async function projectWithClips(): Promise<Editor> {
    const { editor } = makeEditor({ assets: ASSETS });
    for (const assetId of ["a1", "a2", "a3"]) {
      const result = await callTool({ tools, name: "insert_media", args: { assetId }, ctx: { editor, nowMs: () => 0 } });
      if (!result.ok) throw new Error(result.error);
    }
    return editor;
  }

  const run = (editor: Editor, script: ConstructorParameters<typeof ScriptedModelClient>[0]) =>
    runAgent({ goal: "x", history: [], model: new ScriptedModelClient(script), tools: createAgentTools(), editor, planning: approve });

  it("lets a single-element unplanned delete through", async () => {
    const editor = await projectWithClips();
    const [first] = ids(editor);
    await run(editor, [{ content: [use("d1", "delete", { elementIds: [first] })] }, { content: [say("done")] }]);
    expect(ids(editor)).toHaveLength(2);
  });

  it("refuses an unplanned multi-target edit with a pointer to propose_plan and does not spend the free edit", async () => {
    const editor = await projectWithClips();
    const before = ids(editor);
    await run(editor, [
      { content: [use("d1", "delete", { elementIds: before })] },
      (request) => {
        const [refused] = results(request);
        expect(refused?.isError).toBe(true);
        expect(textOf(refused as ToolResultBlock)).toMatch(/propose_plan/);
        return { content: [use("d2", "delete", { elementIds: [before[0]] })] };
      },
      { content: [say("done")] },
    ]);
    expect(ids(editor)).toEqual(before.slice(1));
  });

  it("refuses an unplanned destructive project-wide tool", async () => {
    const editor = await projectWithClips();
    const before = ids(editor);
    await run(editor, [{ content: [use("u1", "undo", { steps: 3 })] }, { content: [say("done")] }]);
    expect(ids(editor)).toEqual(before);
  });

  const narrowPlan = (editor: Editor): AssistantBlock => use("p1", "propose_plan", {
    summary: "Split the first clip at 1s.",
    steps: [{ intent: "Split", tools: ["split"], targets: [`clip ${ids(editor)[0]} (0-10s)`], check: "get_timeline" }],
  });

  it("after approval refuses a tool the plan does not list, with the standard message", async () => {
    const editor = await projectWithClips();
    const before = ids(editor);
    let message = "";
    await run(editor, [
      { content: [narrowPlan(editor)] },
      { content: [use("d1", "delete", { elementIds: [before[0]] })] },
      (request) => {
        message = textOf(results(request)[0] as ToolResultBlock);
        return { content: [say("done")] };
      },
    ]);
    expect(message).toMatch(/not in the approved plan: propose an updated plan/);
    expect(ids(editor)).toEqual(before);
  });

  it("after approval refuses a listed tool aimed at an element outside the declared targets, and allows the declared one", async () => {
    const editor = await projectWithClips();
    const [first, second] = ids(editor) as [string, string];
    const outcomes: boolean[] = [];
    await run(editor, [
      { content: [narrowPlan(editor)] },
      { content: [use("s1", "split", { at: 1, elementIds: [second] }), use("s2", "split", { at: 1, elementIds: [first] })] },
      (request) => {
        outcomes.push(...results(request).map((r) => r.isError));
        return { content: [say("done")] };
      },
    ]);
    expect(outcomes).toEqual([true, false]);
    expect(ids(editor)).toHaveLength(4);
  });

  it("an approved plan can keep working on pieces it created", async () => {
    const editor = await projectWithClips();
    const [first] = ids(editor) as [string];
    const plan = {
      summary: "Split then drop the right half.",
      steps: [{ intent: "Split", tools: ["split", "delete"], targets: [`clip ${first}`], check: "get_timeline" }],
    };
    let right = "";
    await run(editor, [
      { content: [use("p1", "propose_plan", plan)] },
      { content: [use("s1", "split", { at: 1, elementIds: [first] })] },
      (request) => {
        const data = textOf(results(request)[0] as ToolResultBlock);
        right = /"right":"([^"]+)"/.exec(data)?.[1] ?? "";
        return { content: [use("d1", "delete", { elementIds: [right] })] };
      },
      (request) => {
        expect(results(request)[0]?.isError).toBe(false);
        return { content: [say("done")] };
      },
    ]);
    expect(right).not.toBe("");
    expect(ids(editor)).not.toContain(right);
  });

  it("a plan that declares no targets still scopes tools", async () => {
    const editor = await projectWithClips();
    const before = ids(editor);
    const plan = { summary: "s", steps: [{ intent: "Split", tools: ["split"], targets: [], check: "c" }] };
    await run(editor, [
      { content: [use("p1", "propose_plan", plan)] },
      { content: [use("d1", "delete", { elementIds: before })] },
      { content: [say("done")] },
    ]);
    expect(ids(editor)).toEqual(before);
  });

  it("an updated plan re-scopes the run", async () => {
    const editor = await projectWithClips();
    const [first] = ids(editor) as [string];
    const wide = { summary: "s", steps: [{ intent: "Delete", tools: ["delete"], targets: [`clip ${first}`], check: "c" }] };
    await run(editor, [
      { content: [narrowPlan(editor)] },
      { content: [use("p2", "propose_plan", wide)] },
      { content: [use("d1", "delete", { elementIds: [first] })] },
      { content: [say("done")] },
    ]);
    expect(ids(editor)).not.toContain(first);
  });
});
