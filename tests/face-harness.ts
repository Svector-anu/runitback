import { expect } from "vitest";
import { callTool, createAgentTools, type AgentToolRegistry, type ToolResult } from "#/engine/agent";
import { createFaceTools } from "#/engine/agent/tools-face";
import type { Editor } from "#/engine/editor";
import { FACE_INDEX_VERSION, type FaceBox, type FaceDetections, type FaceFrame, type FaceIndexer, type FaceStore } from "#/engine/face";
import type { MediaAssetInfo } from "#/engine/model";
import { createMapAnalysisProvider } from "#/engine/reference";
import { ASSETS } from "./agent-harness";
import { makeEditor } from "./helpers";
import { makeAnalysis } from "./temporal-harness";

export const FAKE_FACE_MODEL = "fake/faces";

export const box = (x: number, y: number, width: number, height: number, score = 0.9): FaceBox => ({ x, y, width, height, score });
export const frame = (t: number, ...boxes: FaceBox[]): FaceFrame => ({ t, boxes });

export function detections(input: { assetId?: string; durationSeconds?: number; frames: FaceFrame[]; model?: string }): FaceDetections {
  return { version: FACE_INDEX_VERSION, assetId: input.assetId ?? "a1", model: input.model ?? FAKE_FACE_MODEL, durationSeconds: input.durationSeconds ?? 10, frames: input.frames };
}

/** A speaker (face 0.12 wide, 0.2 tall) at the given centre. */
export const speaker = (centerX: number, centerY = 0.4): FaceBox => box(centerX - 0.06, centerY - 0.1, 0.12, 0.2);

/**
 * a1 (10 s, 1920x1080), frames every 2 s at 1,3,5,7,9; scene cuts at 4 and 8:
 *   1: one face left   3: one face left   5: no face   7: two faces (left, right)   9: one face right
 */
export const A1_FACE_FRAMES: FaceFrame[] = [
  frame(1, speaker(0.25)),
  frame(3, speaker(0.27)),
  frame(5),
  frame(7, speaker(0.25), speaker(0.75)),
  frame(9, speaker(0.78)),
];
export const A1_CUTS = [4, 8];

export function memoryFaceStore(initial: FaceDetections[] = []): FaceStore & { saved: FaceDetections[] } {
  const byId = new Map(initial.map((d) => [d.assetId, d]));
  const saved: FaceDetections[] = [];
  return {
    saved,
    get: (assetId) => byId.get(assetId),
    save(d) {
      byId.set(d.assetId, d);
      saved.push(d);
    },
    delete: (assetId) => void byId.delete(assetId),
  };
}

export interface FaceHarness {
  editor: Editor;
  tools: AgentToolRegistry;
  store: ReturnType<typeof memoryFaceStore>;
  call(name: string, args?: unknown): Promise<ToolResult>;
  data<T = Record<string, unknown>>(name: string, args?: unknown): Promise<T>;
  failure(name: string, args?: unknown): Promise<{ error: string; hint: string }>;
}

export function setupFaces(options: {
  assets?: MediaAssetInfo[]; faces?: FaceDetections[]; indexer?: FaceIndexer; withAnalysis?: boolean; model?: string;
} = {}): FaceHarness {
  const { editor } = makeEditor({ assets: options.assets ?? ASSETS });
  const store = memoryFaceStore(options.faces ?? [detections({ frames: A1_FACE_FRAMES })]);
  const tools = new Map(createAgentTools());
  const analysis = options.withAnalysis === false ? undefined : createMapAnalysisProvider([makeAnalysis({ cuts: A1_CUTS })]);
  for (const tool of createFaceTools({
    faces: store, ...(options.indexer ? { indexer: options.indexer } : {}), ...(analysis ? { analysis } : {}), ...(options.model ? { model: options.model } : {}),
  })) tools.set(tool.name, tool);
  const ctx = { editor, nowMs: () => 0 };
  const call = (name: string, args: unknown = {}): Promise<ToolResult> => callTool({ tools, name, args, ctx });
  return {
    editor, tools, store, call,
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
