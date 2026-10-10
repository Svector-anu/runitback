import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { callTool, createAgentTools, parsePlan, parseStepUpdate, type AgentTool, type Plan } from "#/engine/agent";
import type { Editor } from "#/engine/editor";
import { runAgent, type AgentEvent, type PlanDecision, type PlanningOptions } from "#/app/agent/loop";
import { ScriptedModelClient, type AssistantBlock, type ModelMessage, type ModelRequest, type ToolResultBlock } from "#/app/agent/model-client";
import { buildSystemPrompt } from "#/app/agent/system-prompt";
import { AgentSession } from "#/app/agent/session";
import { AGENT_ASK_BEFORE_EDITING_PREF, PrefsStore } from "#/platform/prefs";
import { ASSETS } from "./agent-harness";
import { makeEditor } from "./helpers";

const use = (id: string, name: string, input: unknown = {}): AssistantBlock => ({ type: "tool_use", id, name, input });
const say = (text: string): AssistantBlock => ({ type: "text", text });

const PLAN_INPUT = {
  summary: "Put two clips on the main track and cut the first at 4s.",
  steps: [
    { intent: "Insert a1 then a2", tools: ["insert_media"], targets: ["asset a1", "asset a2"], check: "get_timeline shows two clips back to back" },
    { intent: "Split the first clip at 4s", tools: ["split"], targets: ["first clip at 4s"], check: "get_timeline shows three clips" },
  ],
};

const textOf = (block: ToolResultBlock): string => block.content.map((c) => (c.type === "text" ? c.text : "<image>")).join("\n");

function lastResults(request: ModelRequest): ToolResultBlock[] {
  const last = request.messages[request.messages.length - 1] as ModelMessage;
  return last.role === "user" ? last.content.filter((b): b is ToolResultBlock => b.type === "tool_result") : [];
}

const clipCount = (editor: Editor): number => editor.getState().doc.scenes.flatMap((s) => s.tracks.main.elements).length;

function setup(extra: AgentTool[] = []) {
  const { editor } = makeEditor({ assets: ASSETS });
  const events: AgentEvent[] = [];
  const tools = new Map(createAgentTools());
  for (const tool of extra) tools.set(tool.name, tool);
  const base = { editor, tools, history: [] as ModelMessage[], onEvent: (e: AgentEvent) => events.push(e) };
  return { editor, events, base };
}

function asking(decisions: PlanDecision[], onAsk: (plan: Plan) => void = () => undefined): PlanningOptions {
  const queue = [...decisions];
  return {
    mode: "ask",
    decide: async (plan) => {
      onAsk(plan);
      const next = queue.shift();
      if (!next) throw new Error("no scripted decision left");
      return next;
    },
  };
}

describe("parsePlan", () => {
  it("normalizes a valid plan", () => {
    const parsed = parsePlan({ ...PLAN_INPUT, summary: "  Cut   it  " }, ["insert_media", "split"]);
    expect(parsed.ok && parsed.plan.summary).toBe("Cut it");
    expect(parsed.ok && parsed.plan.steps).toHaveLength(2);
  });

  it("rejects empty, oversized, malformed and unknown-tool plans with a hint", () => {
    expect(parsePlan({ summary: "x", steps: [] }).ok).toBe(false);
    expect(parsePlan({ summary: "x", steps: Array.from({ length: 13 }, () => PLAN_INPUT.steps[0]) }).ok).toBe(false);
    expect(parsePlan({ summary: "x", steps: [{ intent: "a" }] }).ok).toBe(false);
    const unknown = parsePlan({ summary: "x", steps: [{ ...PLAN_INPUT.steps[0], tools: ["insert_mediaa"] }] }, ["insert_media"]);
    expect(unknown.ok).toBe(false);
    expect(!unknown.ok && unknown.hint).toContain("insert_media");
  });

  it("validates step updates against the plan length", () => {
    expect(parseStepUpdate({ step: 2, status: "done", note: "ok" }, 2).ok).toBe(true);
    expect(parseStepUpdate({ step: 3, status: "done" }, 2).ok).toBe(false);
    expect(parseStepUpdate({ step: 1, status: "pending" }, 2).ok).toBe(false);
  });
});

describe("plan-then-execute loop", () => {
  it("shows the plan and leaves the document untouched until the user approves, then runs it as one undo step", async () => {
    const { editor, events, base } = setup();
    const before = editor.getState().doc;
    const docAtAsk: unknown[] = [];
    const model = new ScriptedModelClient([
      { content: [say("Plan coming."), use("p1", "propose_plan", PLAN_INPUT)] },
      (request) => {
        expect(textOf(lastResults(request)[0] as ToolResultBlock)).toContain("approved");
        return { content: [use("s1", "update_plan_step", { step: 1, status: "running" }), use("e1", "insert_media", { assetId: "a1" }), use("e2", "insert_media", { assetId: "a2" })] };
      },
      { content: [use("s2", "update_plan_step", { step: 1, status: "done", note: "2 clips" }), use("s3", "update_plan_step", { step: 2, status: "running" }), use("e3", "split", { at: 4 })] },
      { content: [use("s4", "update_plan_step", { step: 2, status: "done", note: "3 clips" })] },
      { content: [say("Done.\nVerification: 3 clips on main, no gaps.")] },
    ]);
    const result = await runAgent({ ...base, model, goal: "build it", planning: asking([{ kind: "approve" }], () => docAtAsk.push(editor.getState().doc)) });

    expect(docAtAsk).toEqual([before]);
    expect(result.status).toBe("done");
    expect(clipCount(editor)).toBe(3);
    expect(events.filter((e) => e.type === "plan")).toHaveLength(1);
    expect(events.map((e) => e.type === "plan_decision" && e.decision).filter(Boolean)).toEqual(["approved"]);
    expect(events.filter((e) => e.type === "plan_step").map((e) => e.type === "plan_step" && `${e.step}:${e.status}`)).toEqual(["1:running", "1:done", "2:running", "2:done"]);
    expect(editor.undo()).toBe(true);
    expect(editor.getState().doc).toBe(before);
    expect(editor.getState().canUndo).toBe(false);
  });

  it("tags tool results with the running step", async () => {
    const { events, base } = setup();
    const model = new ScriptedModelClient([
      { content: [use("p1", "propose_plan", PLAN_INPUT)] },
      { content: [use("e0", "get_timeline"), use("s1", "update_plan_step", { step: 1, status: "running" }), use("e1", "insert_media", { assetId: "a1" })] },
      { content: [say("ok")] },
    ]);
    await runAgent({ ...base, model, goal: "x", planning: { mode: "auto-approve" } });
    const results = events.filter((e) => e.type === "tool_result");
    expect(results.map((e) => e.type === "tool_result" && e.planStep)).toEqual([undefined, 1]);
  });

  it("rejecting leaves the document, history and conversation valid and stops the run", async () => {
    const { editor, events, base } = setup();
    const before = editor.getState().doc;
    const model = new ScriptedModelClient([
      { content: [use("p1", "propose_plan", PLAN_INPUT), use("e1", "insert_media", { assetId: "a1" })] },
      { content: [say("must not run")] },
    ]);
    const result = await runAgent({ ...base, model, goal: "build it", planning: asking([{ kind: "reject" }]) });
    expect(result.status).toBe("rejected");
    expect(result.changed).toBe(false);
    expect(editor.getState().doc).toBe(before);
    expect(editor.getState().canUndo).toBe(false);
    expect(editor.inTransaction).toBe(false);
    expect(model.remaining).toBe(1);
    expect(events.at(-1)).toMatchObject({ type: "done", status: "rejected" });
    const roles = result.history.map((m) => m.role);
    expect(roles).toEqual(["user", "assistant", "user", "assistant"]);
    const toolResults = (result.history[2] as { content: ToolResultBlock[] }).content;
    expect(toolResults.map((b) => b.toolUseId)).toEqual(["p1", "e1"]);
  });

  it("undoes an earlier unplanned edit when a plan follows, so the project is untouched while the plan waits", async () => {
    const { editor, events, base } = setup();
    const before = editor.getState().doc;
    const docAtAsk: unknown[] = [];
    const model = new ScriptedModelClient([
      { content: [use("e1", "insert_media", { assetId: "a1" }), use("e2", "insert_media", { assetId: "a2" })] },
      { content: [use("p1", "propose_plan", PLAN_INPUT)] },
      (request) => {
        const result = lastResults(request)[0] as ToolResultBlock;
        expect(textOf(result)).toContain("was undone");
        return { content: [use("e3", "insert_media", { assetId: "a1" }), use("e4", "insert_media", { assetId: "a2" })] };
      },
      { content: [say("Verification: 2 clips.")] },
    ]);
    const result = await runAgent({ ...base, model, goal: "x", planning: asking([{ kind: "approve" }], () => docAtAsk.push(editor.getState().doc)) });
    expect(docAtAsk).toEqual([before]);
    expect(result.status).toBe("done");
    expect(clipCount(editor)).toBe(2);
    expect(events.some((e) => e.type === "notice")).toBe(true);
    expect(editor.undo()).toBe(true);
    expect(editor.getState().doc).toBe(before);
  });

  it("revise sends the feedback to the model, which proposes again; only the approved plan runs", async () => {
    const { editor, events, base } = setup();
    const revised = { ...PLAN_INPUT, steps: [PLAN_INPUT.steps[0] as (typeof PLAN_INPUT.steps)[number]] };
    const model = new ScriptedModelClient([
      { content: [use("p1", "propose_plan", PLAN_INPUT)] },
      (request) => {
        const text = textOf(lastResults(request)[0] as ToolResultBlock);
        expect(text).toContain("only insert, do not split");
        expect(text).toContain("Nothing was edited");
        expect(clipCount(editor)).toBe(0);
        return { content: [use("p2", "propose_plan", revised)] };
      },
      { content: [use("e1", "insert_media", { assetId: "a1" })] },
      { content: [say("Verification: 1 clip.")] },
    ]);
    const asked: Plan[] = [];
    const result = await runAgent({
      ...base, model, goal: "x",
      planning: asking([{ kind: "revise", feedback: "only insert, do not split" }, { kind: "approve" }], (p) => asked.push(p)),
    });
    expect(result.status).toBe("done");
    expect(asked.map((p) => p.steps.length)).toEqual([2, 1]);
    expect(events.filter((e) => e.type === "plan").map((e) => e.type === "plan" && e.revision)).toEqual([1, 2]);
    expect(events.filter((e) => e.type === "plan_decision").map((e) => e.type === "plan_decision" && e.decision)).toEqual(["revise", "approved"]);
    expect(clipCount(editor)).toBe(1);
  });

  it("refuses edits in the same response as an unapproved plan and until the revision is approved", async () => {
    const { editor, base } = setup();
    const model = new ScriptedModelClient([
      { content: [use("p1", "propose_plan", PLAN_INPUT), use("e1", "insert_media", { assetId: "a1" })] },
      (request) => {
        expect(lastResults(request).map((b) => b.isError)).toEqual([false, true]);
        return { content: [use("e2", "insert_media", { assetId: "a1" })] };
      },
      (request) => {
        expect(textOf(lastResults(request)[0] as ToolResultBlock)).toContain("not been approved");
        return { content: [say("Waiting for your answer.")] };
      },
    ]);
    const result = await runAgent({ ...base, model, goal: "x", planning: asking([{ kind: "revise", feedback: "hmm" }]) });
    expect(result.status).toBe("done");
    expect(clipCount(editor)).toBe(0);
    expect(result.changed).toBe(false);
  });

  it("allows one unplanned edit, then requires a plan for the next", async () => {
    const { editor, base } = setup();
    const model = new ScriptedModelClient([
      { content: [use("e1", "insert_media", { assetId: "a1" }), use("e2", "insert_media", { assetId: "a2" })] },
      (request) => {
        const [first, second] = lastResults(request);
        expect(first?.isError).toBe(false);
        expect(second?.isError).toBe(true);
        expect(textOf(second as ToolResultBlock)).toContain("propose_plan");
        return { content: [use("e3", "get_timeline")] };
      },
      { content: [say("one clip")] },
    ]);
    const result = await runAgent({ ...base, model, goal: "add a1", planning: asking([]) });
    expect(clipCount(editor)).toBe(1);
    expect(result.changed).toBe(true);
  });

  it("auto-approve records the plan and runs without asking", async () => {
    const { editor, events, base } = setup();
    const model = new ScriptedModelClient([
      { content: [use("p1", "propose_plan", PLAN_INPUT)] },
      { content: [use("e1", "insert_media", { assetId: "a1" }), use("e2", "insert_media", { assetId: "a2" })] },
      { content: [say("done")] },
    ]);
    const result = await runAgent({ ...base, model, goal: "x", planning: { mode: "auto-approve" } });
    expect(result.status).toBe("done");
    expect(clipCount(editor)).toBe(2);
    expect(events.map((e) => e.type === "plan_decision" && e.decision).filter(Boolean)).toEqual(["approved"]);
  });

  it("rejects malformed plans and step updates before approval with an error the model can fix", async () => {
    const { base } = setup();
    const asked: Plan[] = [];
    const model = new ScriptedModelClient([
      { content: [use("p0", "update_plan_step", { step: 1, status: "running" }), use("p1", "propose_plan", { summary: "x", steps: [{ ...PLAN_INPUT.steps[0], tools: ["nope_tool"] }] })] },
      (request) => {
        const [update, plan] = lastResults(request);
        expect(update?.isError && textOf(update)).toContain("no approved plan");
        expect(plan?.isError && textOf(plan)).toContain("unknown tool");
        return { content: [say("giving up")] };
      },
    ]);
    await runAgent({ ...base, model, goal: "x", planning: asking([], (p) => asked.push(p)) });
    expect(asked).toHaveLength(0);
  });

  it("does not approve when the project changed while the plan waited", async () => {
    const { editor, events, base } = setup();
    const model = new ScriptedModelClient([
      { content: [use("p1", "propose_plan", PLAN_INPUT)] },
      (request) => {
        expect(textOf(lastResults(request)[0] as ToolResultBlock)).toContain("changed while the plan was waiting");
        return { content: [say("re-checking")] };
      },
    ]);
    const planning: PlanningOptions = {
      mode: "ask",
      decide: async () => {
        await callTool({ tools: base.tools, name: "insert_media", args: { assetId: "a3" }, ctx: { editor, nowMs: () => 0 } });
        return { kind: "approve" };
      },
    };
    const result = await runAgent({ ...base, model, goal: "x", planning });
    expect(events.map((e) => e.type === "plan_decision" && e.decision).filter(Boolean)).toEqual(["revise"]);
    expect(result.status).toBe("done");
  });

  it("stopping while a plan waits rolls back and ends as aborted", async () => {
    const { editor, base } = setup();
    const controller = new AbortController();
    const before = editor.getState().doc;
    const model = new ScriptedModelClient([{ content: [use("p1", "propose_plan", PLAN_INPUT)] }]);
    const planning: PlanningOptions = { mode: "ask", decide: () => new Promise<PlanDecision>(() => controller.abort()) };
    const result = await runAgent({ ...base, model, goal: "x", planning, signal: controller.signal });
    expect(result.status).toBe("aborted");
    expect(editor.getState().doc).toBe(before);
    expect(editor.inTransaction).toBe(false);
  });

  it("with planning off there is no plan tool, no gate and no plan protocol in the prompt", async () => {
    const { editor, base } = setup();
    const model = new ScriptedModelClient([
      { content: [use("e1", "insert_media", { assetId: "a1" }), use("e2", "insert_media", { assetId: "a2" }), use("p1", "propose_plan", PLAN_INPUT)] },
      (request) => {
        expect(lastResults(request).map((b) => b.isError)).toEqual([false, false, true]);
        return { content: [say("done")] };
      },
    ]);
    await runAgent({ ...base, model, goal: "x" });
    const request = model.requests[0] as ModelRequest;
    expect(request.tools.map((t) => t.name)).not.toContain("propose_plan");
    expect(request.system).toBe(buildSystemPrompt({ planning: false }));
    expect(request.system).not.toContain("propose_plan");
    expect(clipCount(editor)).toBe(2);
  });

  it("with planning on the model sees both plan tools and the protocol", async () => {
    const { base } = setup();
    const model = new ScriptedModelClient([{ content: [say("hi")] }]);
    await runAgent({ ...base, model, goal: "x", planning: { mode: "auto-approve" } });
    const request = model.requests[0] as ModelRequest;
    expect(request.tools.map((t) => t.name)).toEqual(expect.arrayContaining(["propose_plan", "update_plan_step"]));
    expect(request.system).toContain("propose_plan");
    expect(request.system).toContain("Verification:");
  });
});

describe("a wait for the user never holds the run's transaction", () => {
  const userEdit = async (base: { tools: Map<string, AgentTool> }, editor: Editor): Promise<void> => {
    const result = await callTool({ tools: base.tools, name: "insert_media", args: { assetId: "a3" }, ctx: { editor, nowMs: () => 0 } });
    expect(result.ok).toBe(true);
  };

  it("rejecting after the user edited during the wait keeps the user's edit and a valid history", async () => {
    const { editor, base } = setup();
    const model = new ScriptedModelClient([{ content: [use("p1", "propose_plan", PLAN_INPUT)] }]);
    let during: unknown;
    const planning: PlanningOptions = {
      mode: "ask",
      decide: async () => {
        expect(editor.inTransaction).toBe(false);
        await userEdit(base, editor);
        during = editor.getState().doc;
        return { kind: "reject" };
      },
    };
    const result = await runAgent({ ...base, model, goal: "x", planning });
    expect(result.status).toBe("rejected");
    expect(result.changed).toBe(false);
    expect(editor.getState().doc).toBe(during);
    expect(clipCount(editor)).toBe(1);
    expect(editor.inTransaction).toBe(false);
    expect(editor.undo()).toBe(true);
    expect(clipCount(editor)).toBe(0);
    expect(editor.getState().canUndo).toBe(false);
  });

  it("approving after a user edit forces a re-plan, keeps the edit, and the approved run then undoes back to the state before it", async () => {
    const { editor, events, base } = setup();
    let first = true;
    let beforeApprovedRun: unknown;
    const model = new ScriptedModelClient([
      { content: [use("p1", "propose_plan", PLAN_INPUT)] },
      (request) => {
        expect(textOf(lastResults(request)[0] as ToolResultBlock)).toContain("changed while the plan was waiting");
        expect(clipCount(editor)).toBe(1);
        return { content: [use("p2", "propose_plan", PLAN_INPUT)] };
      },
      () => {
        beforeApprovedRun = editor.getState().doc;
        return { content: [use("e1", "insert_media", { assetId: "a1" })] };
      },
      { content: [say("Verification: 2 clips.")] },
    ]);
    const planning: PlanningOptions = {
      mode: "ask",
      decide: async () => {
        if (first) {
          first = false;
          await userEdit(base, editor);
        }
        return { kind: "approve" };
      },
    };
    const result = await runAgent({ ...base, model, goal: "x", planning });
    expect(result.status).toBe("done");
    expect(result.changed).toBe(true);
    expect(clipCount(editor)).toBe(2);
    expect(events.filter((e) => e.type === "plan_decision").map((e) => e.type === "plan_decision" && e.decision)).toEqual(["revise", "approved"]);
    expect(editor.undo()).toBe(true);
    expect(editor.getState().doc).toBe(beforeApprovedRun);
    expect(clipCount(editor)).toBe(1);
  });

  it("stopping while a plan waits loses nothing the user did meanwhile", async () => {
    const { editor, base } = setup();
    const controller = new AbortController();
    const model = new ScriptedModelClient([{ content: [use("p1", "propose_plan", PLAN_INPUT)] }]);
    const planning: PlanningOptions = {
      mode: "ask",
      decide: () => new Promise<PlanDecision>(() => {
        void userEdit(base, editor).then(() => controller.abort());
      }),
    };
    const result = await runAgent({ ...base, model, goal: "x", planning, signal: controller.signal });
    expect(result.status).toBe("aborted");
    expect(result.changed).toBe(false);
    expect(clipCount(editor)).toBe(1);
    expect(editor.inTransaction).toBe(false);
    expect(editor.undo()).toBe(true);
    expect(clipCount(editor)).toBe(0);
  });

  it("does not revert the unplanned edit when the project changed after it", async () => {
    const { editor, base } = setup();
    const sneaky: AgentTool = {
      name: "sneaky", description: "mutates behind the loop's back", inputSchema: { type: "object", properties: {} }, readOnly: true,
      async run() {
        await userEdit(base, editor);
        return { ok: true, summary: "x" };
      },
    };
    base.tools.set("sneaky", sneaky);
    const model = new ScriptedModelClient([
      { content: [use("e1", "insert_media", { assetId: "a1" }), use("s1", "sneaky"), use("p1", "propose_plan", PLAN_INPUT)] },
      (request) => {
        expect(textOf(lastResults(request)[2] as ToolResultBlock)).toContain("was kept because the project changed");
        return { content: [say("ok")] };
      },
    ]);
    const result = await runAgent({ ...base, model, goal: "x", planning: asking([{ kind: "revise", feedback: "x" }]) });
    expect(model.remaining).toBe(0);
    expect(result.status).toBe("done");
    expect(clipCount(editor)).toBe(2);
    expect(result.changed).toBe(true);
  });
});

describe("AgentSession plan state", () => {
  const memoryPrefs = (): PrefsStore => {
    const data = new Map<string, string>();
    return new PrefsStore({ getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) });
  };

  function session(prefs: PrefsStore, model: ScriptedModelClient) {
    const { editor } = makeEditor({ assets: ASSETS });
    return { editor, session: new AgentSession({ editor, runtime: () => { throw new Error("runtime unused"); }, prefs, currentProjectId: () => "p", testModel: () => model }) };
  }

  it("asks before editing by default and persists the setting", () => {
    const prefs = memoryPrefs();
    const { session: s } = session(prefs, new ScriptedModelClient([]));
    expect(s.getState().askBeforeEditing).toBe(true);
    s.setAskBeforeEditing(false);
    expect(prefs.read(AGENT_ASK_BEFORE_EDITING_PREF, true, (v): v is boolean => typeof v === "boolean")).toBe(false);
    expect(session(prefs, new ScriptedModelClient([])).session.getState().askBeforeEditing).toBe(false);
  });

  it("pauses on a plan, marks steps as the run proceeds and keeps the verification line", async () => {
    const model = new ScriptedModelClient([
      { content: [use("p1", "propose_plan", PLAN_INPUT)] },
      { content: [use("s1", "update_plan_step", { step: 1, status: "running" }), use("e1", "insert_media", { assetId: "a1" })] },
      { content: [use("s2", "update_plan_step", { step: 1, status: "done", note: "1 clip" })] },
      { content: [say("All set.\n**Verification:** 1 clip on main, 10.0s long.")] },
    ]);
    const { editor, session: s } = session(memoryPrefs(), model);
    const run = s.send("add a1");
    await new Promise((r) => setTimeout(r, 0));
    expect(s.getState().awaitingPlan).toBe(true);
    expect(clipCount(editor)).toBe(0);
    const awaiting = s.getState().items.find((i) => i.kind === "plan");
    expect(awaiting).toMatchObject({ kind: "plan", status: "awaiting" });

    s.approvePlan();
    const result = await run;
    expect(result?.status).toBe("done");
    const plan = s.getState().items.find((i) => i.kind === "plan");
    expect(plan).toMatchObject({ status: "approved", verification: "1 clip on main, 10.0s long." });
    expect(plan?.kind === "plan" && plan.steps.map((st) => st.status)).toEqual(["done", "pending"]);
    expect(plan?.kind === "plan" && plan.steps[0]?.results[0]?.summary).toBeTruthy();
    expect(s.getState().undoableDoc).not.toBeNull();
  });

  it("reject leaves the project untouched and offers no undo", async () => {
    const model = new ScriptedModelClient([{ content: [use("p1", "propose_plan", PLAN_INPUT)] }]);
    const { editor, session: s } = session(memoryPrefs(), model);
    const run = s.send("build");
    await new Promise((r) => setTimeout(r, 0));
    s.rejectPlan();
    const result = await run;
    expect(result?.status).toBe("rejected");
    expect(clipCount(editor)).toBe(0);
    expect(s.getState().undoableDoc).toBeNull();
    expect(s.getState().items.find((i) => i.kind === "plan")).toMatchObject({ status: "rejected" });
  });
});
