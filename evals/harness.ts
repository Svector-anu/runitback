import { runAgent, type AgentEvent } from "#/app/agent/loop";
import type { ModelClient } from "#/app/agent/model-client";
import { createAgentTools, createTemporalTools, createTranscriptTools, type AgentTool } from "#/engine/agent";
import { Editor } from "#/engine/editor";
import { createProject, sequentialIds, type Project } from "#/engine/model";
import { createMapAnalysisProvider, createMemoryStyleProfileStore } from "#/engine/reference";
import { createMemoryTranscriptStore, TRANSCRIPT_VERSION } from "#/engine/transcript";
import { analysisFromSpec, assetInfoOf, resolveFixtures } from "./fixtures";
import { scoreCase } from "./score";
import { placeInitialTimeline } from "./setup";
import { visualToolsFor } from "./visual";
import { createStubPlatformTools } from "./stub-tools";
import type { CaseResult, EvalCase, ResolvedFixture, RunSummary } from "./types";

const FIXED_NOW = "2026-01-01T00:00:00.000Z";

export interface World {
  editor: Editor;
  fixtures: ResolvedFixture[];
  tools: Map<string, AgentTool>;
  initial: Project;
}

/** A headless project holding the case's fixtures, with exact analyses and stub renderers behind the tools. */
export async function buildWorld(evalCase: EvalCase): Promise<World> {
  const newId = sequentialIds("e");
  const editor = new Editor({ newId, now: () => FIXED_NOW });
  const fixtures = resolveFixtures(evalCase.fixtures);
  editor.load({ project: createProject({ id: `eval-${evalCase.id}`, name: evalCase.title, ids: newId, now: FIXED_NOW }), assets: fixtures.map((f) => assetInfoOf(f.spec)) });

  const analyses = new Map(fixtures.map((f) => [f.assetId, analysisFromSpec(f.spec)]));
  const provider = createMapAnalysisProvider(analyses.values());
  const tools = new Map(createAgentTools({ reference: { store: createMemoryStyleProfileStore(), provider } }));
  const transcripts = fixtures.filter((f) => f.spec.transcript !== undefined);
  const store = createMemoryTranscriptStore();
  for (const f of transcripts) store.save({ version: TRANSCRIPT_VERSION, assetId: f.assetId, language: "en", model: "fixture", words: f.spec.transcript ?? [] });
  if (transcripts.length > 0) for (const tool of createTranscriptTools({ store })) tools.set(tool.name, tool);
  for (const tool of createTemporalTools({ analysis: provider, transcripts: store })) tools.set(tool.name, tool);
  for (const tool of visualToolsFor(fixtures)) tools.set(tool.name, tool);
  for (const tool of createStubPlatformTools({ editor, fixtures, analyses })) tools.set(tool.name, tool);

  await placeInitialTimeline({ editor, tools, fixtures });
  return { editor, fixtures, tools, initial: editor.toProject() };
}

export interface RunCaseOptions {
  evalCase: EvalCase;
  policyId: string;
  model: ModelClient;
  modelName?: string;
  /** Called for every agent event (progress output for the real runner). */
  onEvent?: (event: AgentEvent) => void;
}

/** Runs one case end to end against a model client and scores it. Never throws for agent failures. */
export async function runCase(options: RunCaseOptions): Promise<CaseResult> {
  const { evalCase } = options;
  const world = await buildWorld(evalCase);
  const toolCalls: string[] = [];
  const result = await runAgent({
    goal: evalCase.brief,
    history: [],
    model: options.model,
    ...(options.modelName ? { modelName: options.modelName } : {}),
    tools: world.tools,
    editor: world.editor,
    maxSteps: evalCase.budget.maxSteps,
    tokenBudget: evalCase.budget.maxTokens,
    label: `Eval: ${evalCase.id}`,
    onEvent: (event) => {
      if (event.type === "tool_call") toolCalls.push(event.name);
      options.onEvent?.(event);
    },
  });
  const final = world.editor.toProject();
  let afterUndo = final;
  if (result.changed && world.editor.undo()) afterUndo = world.editor.toProject();
  const run: RunSummary = {
    status: result.status, finalText: result.finalText, steps: result.steps, changed: result.changed, usage: result.usage,
    ...(result.error ? { error: result.error } : {}),
  };
  return scoreCase({
    evalCase, policyId: options.policyId, toolCalls,
    check: { initial: world.initial, final, afterUndo, fixtures: world.fixtures, run },
  });
}
