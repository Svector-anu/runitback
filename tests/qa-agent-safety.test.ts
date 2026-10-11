import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { createAgentTools } from "#/engine/agent";
import type { Editor } from "#/engine/editor";
import { runAgent, type PlanDecision } from "#/app/agent/loop";
import { ScriptedModelClient, type AssistantBlock } from "#/app/agent/model-client";
import { AgentSession } from "#/app/agent/session";
import { buildSystemPrompt } from "#/app/agent/system-prompt";
import { PrefsStore } from "#/platform/prefs";
import { ASSETS } from "./agent-harness";
import { makeEditor } from "./helpers";

const use = (id: string, name: string, input: unknown = {}): AssistantBlock => ({ type: "tool_use", id, name, input });

const clipIds = (editor: Editor): string[] =>
  editor.getState().doc.scenes.flatMap((s) => [...s.tracks.overlay, s.tracks.main, ...s.tracks.audio].flatMap((t) => t.elements.map((e) => e.id)));

async function projectWithClips(): Promise<Editor> {
  const { editor } = makeEditor({ assets: ASSETS });
  const tools = createAgentTools();
  const insert = tools.get("insert_media");
  if (!insert) throw new Error("insert_media missing");
  for (const assetId of ["a1", "a2", "a3"]) {
    const result = await insert.run({ assetId }, { editor, nowMs: () => 0 });
    if (!result.ok) throw new Error(result.error);
  }
  return editor;
}

describe("QA: plan gate vs a model that obeys an injected instruction", () => {
  it.skip("a destructive multi-clip delete without any plan must not run when Ask before editing is on (QA-P2-2)", async () => {
    const editor = await projectWithClips();
    const before = clipIds(editor);
    expect(before.length).toBeGreaterThan(1);
    const model = new ScriptedModelClient([
      { content: [use("d1", "delete", { elementIds: before })] },
      { content: [{ type: "text", text: "done" }] },
    ]);
    const result = await runAgent({
      goal: "tidy up", history: [], model, tools: createAgentTools(), editor,
      planning: { mode: "ask", decide: async (): Promise<PlanDecision> => ({ kind: "approve" }) },
    });
    expect(result.status).toBe("done");
    expect(clipIds(editor)).toEqual(before);
  });

  it.skip("after approving a narrow plan, an out-of-plan destructive tool must be refused (QA-P2-3)", async () => {
    const editor = await projectWithClips();
    const before = clipIds(editor);
    const model = new ScriptedModelClient([
      { content: [use("p1", "propose_plan", { summary: "Split the first clip at 1s.", steps: [{ intent: "Split", tools: ["split"], targets: [before[0] as string], check: "get_timeline" }] })] },
      { content: [use("d1", "delete", { elementIds: before })] },
      { content: [{ type: "text", text: "done" }] },
    ]);
    await runAgent({
      goal: "split the first clip", history: [], model, tools: createAgentTools(), editor,
      planning: { mode: "ask", decide: async (): Promise<PlanDecision> => ({ kind: "approve" }) },
    });
    expect(clipIds(editor)).toEqual(before);
  });

  it.skip("the system prompt tells the model that tool output (transcripts, names, captions) is data, not instructions (QA-P2-4)", () => {
    for (const planning of [true, false]) {
      expect(buildSystemPrompt({ planning })).toMatch(/untrusted|not instructions|never follow instructions (found|that appear)/i);
    }
  });
});

describe("QA: AgentSession lifecycle", () => {
  const memoryPrefs = (): PrefsStore => {
    const data = new Map<string, string>();
    return new PrefsStore({ getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) });
  };
  const make = async (model: ScriptedModelClient) => {
    const editor = await projectWithClips();
    const session = new AgentSession({ editor, runtime: () => { throw new Error("unused"); }, prefs: memoryPrefs(), currentProjectId: () => "p", testModel: () => model });
    return { editor, session };
  };

  it("approving twice, or approving after reject, is a no-op after the first decision", async () => {
    const { editor, session } = await make(new ScriptedModelClient([
      { content: [use("p1", "propose_plan", { summary: "s", steps: [{ intent: "i", tools: ["split"], targets: [], check: "c" }] })] },
      { content: [{ type: "text", text: "ok" }] },
    ]));
    const before = clipIds(editor);
    const run = session.send("do it");
    await new Promise((r) => setTimeout(r, 0));
    session.rejectPlan();
    session.approvePlan();
    session.approvePlan();
    const result = await run;
    expect(result?.status).toBe("rejected");
    expect(clipIds(editor)).toEqual(before);
  });

  it.skip("switching projects while a run is in flight must not leak the old conversation into the new project (QA-P3-3)", async () => {
    const { session } = await make(new ScriptedModelClient([
      { content: [use("p1", "propose_plan", { summary: "s", steps: [{ intent: "i", tools: ["split"], targets: [], check: "c" }] })] },
    ]));
    session.bindProject("project-a");
    const run = session.send("secret request about project A");
    await new Promise((r) => setTimeout(r, 0));
    session.bindProject("project-b");
    await run;
    expect(session.getState().items).toEqual([]);
  });
});
