import { expect } from "vitest";
import { callTool, createAgentTools, createTemporalTools, createVisualTools, type AgentToolRegistry, type ToolResult } from "#/engine/agent";
import type { Editor } from "#/engine/editor";
import type { MediaAssetInfo } from "#/engine/model";
import { createMapAnalysisProvider } from "#/engine/reference";
import { createMemoryTranscriptStore } from "#/engine/transcript";
import { VISUAL_INDEX_VERSION, createMemoryVisualStore, normalize, type VisualEmbeddings, type VisualIndexer, type VisualSearcher } from "#/engine/visual";
import { ASSETS } from "./agent-harness";
import { makeEditor } from "./helpers";

/** A 4-d "image model": each axis is one concept, so cosine scores are exact and readable. */
export const CONCEPTS = ["dog", "whiteboard", "laugh", "sky"] as const;
export type Concept = (typeof CONCEPTS)[number];
export const FAKE_MODEL = "fake/clip";

export function vectorOf(mix: Partial<Record<Concept, number>>): Float32Array {
  return normalize(Float32Array.from(CONCEPTS.map((concept) => mix[concept] ?? 0)));
}

export interface FakeFrame {
  time: number;
  mix: Partial<Record<Concept, number>>;
}

export function makeEmbeddings(input: { assetId?: string; durationSeconds?: number; cuts?: number[]; frames: FakeFrame[]; model?: string }): VisualEmbeddings {
  const rows = input.frames.map((f) => vectorOf(f.mix));
  const vectors = new Float32Array(rows.length * CONCEPTS.length);
  rows.forEach((row, i) => vectors.set(row, i * CONCEPTS.length));
  return {
    version: VISUAL_INDEX_VERSION, assetId: input.assetId ?? "a1", model: input.model ?? FAKE_MODEL, dimensions: CONCEPTS.length,
    durationSeconds: input.durationSeconds ?? 10, cuts: input.cuts ?? [], times: input.frames.map((f) => f.time), vectors,
  };
}

/**
 * a1 (10 s), shots [0,4) [4,8) [8,10), a frame every 2 s at 1,3,5,7,9:
 *   1: sky   3: dog   5: dog + a bit of whiteboard   7: laugh   9: sky
 */
export const A1_FRAMES: FakeFrame[] = [
  { time: 1, mix: { sky: 1 } },
  { time: 3, mix: { dog: 1 } },
  { time: 5, mix: { dog: 1, whiteboard: 0.25 } },
  { time: 7, mix: { laugh: 1 } },
  { time: 9, mix: { sky: 1 } },
];
export const A1_CUTS = [4, 8];

export interface FakeSearcher extends VisualSearcher {
  queries: string[];
}

/** Embeds a query as the sum of the concept words it contains; anything else is the zero vector (matches nothing). */
export function fakeSearcher(model = FAKE_MODEL): FakeSearcher {
  const queries: string[] = [];
  return {
    model, queries,
    async embedText(query) {
      queries.push(query);
      const mix: Partial<Record<Concept, number>> = {};
      for (const concept of CONCEPTS) if (query.toLowerCase().includes(concept)) mix[concept] = 1;
      return vectorOf(mix);
    },
  };
}

export interface VisualHarness {
  editor: Editor;
  tools: AgentToolRegistry;
  store: ReturnType<typeof createMemoryVisualStore>;
  searcher: FakeSearcher;
  indexed: string[];
  call(name: string, args?: unknown): Promise<ToolResult>;
  data<T = Record<string, unknown>>(name: string, args?: unknown): Promise<T>;
  failure(name: string, args?: unknown): Promise<{ error: string; hint: string }>;
}

export function setupVisual(options: { assets?: MediaAssetInfo[]; embeddings?: VisualEmbeddings[]; withIndexer?: boolean; indexer?: VisualIndexer } = {}): VisualHarness {
  const { editor } = makeEditor({ assets: options.assets ?? ASSETS });
  const store = createMemoryVisualStore();
  for (const e of options.embeddings ?? [makeEmbeddings({ frames: A1_FRAMES, cuts: A1_CUTS })]) store.save(e);
  const searcher = fakeSearcher();
  const indexed: string[] = [];
  const indexer: VisualIndexer | undefined = options.indexer ?? (options.withIndexer
    ? { async index({ assetId }) { indexed.push(assetId); return makeEmbeddings({ assetId, frames: A1_FRAMES, cuts: A1_CUTS }); } }
    : undefined);
  const tools = new Map(createAgentTools());
  for (const tool of createTemporalTools({ analysis: createMapAnalysisProvider([]), transcripts: createMemoryTranscriptStore() })) tools.set(tool.name, tool);
  for (const tool of createVisualTools({ store, searcher, ...(indexer ? { indexer } : {}) })) tools.set(tool.name, tool);
  const ctx = { editor, nowMs: () => 0 };
  const call = (name: string, args: unknown = {}): Promise<ToolResult> => callTool({ tools, name, args, ctx });
  return {
    editor, tools, store, searcher, indexed, call,
    async data<T>(name: string, args?: unknown): Promise<T> {
      const result = await call(name, args);
      if (!result.ok) throw new Error(`${name} failed: ${result.error} (${result.hint ?? "no hint"})`);
      return result.data as T;
    },
    async failure(name: string, args?: unknown) {
      const result = await call(name, args);
      expect(result.ok, `${name} should fail`).toBe(false);
      if (result.ok) throw new Error("unreachable");
      return { error: result.error, hint: result.hint ?? "" };
    },
  };
}
