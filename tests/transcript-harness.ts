import { expect } from "vitest";
import { callTool, type AgentToolRegistry, type ToolResult } from "#/engine/agent";
import { createTranscriptTools, type TranscriptDeps } from "#/engine/agent/tools-transcript";
import { createAgentTools } from "#/engine/agent";
import type { Editor } from "#/engine/editor";
import type { MediaAssetInfo } from "#/engine/model";
import { allElements } from "#/engine/timeline";
import { TICKS_PER_SECOND } from "#/engine/time";
import { createMemoryTranscriptStore, TRANSCRIPT_VERSION, type Transcript, type TranscriptWord } from "#/engine/transcript";
import { ASSETS } from "./agent-harness";
import { makeEditor } from "./helpers";

export const word = (text: string, startSeconds: number, endSeconds: number): TranscriptWord => ({ text, startSeconds, endSeconds });

/** Source seconds of asset a1 (10 s). Sentence 2 is "We should probably skip this part." */
export const TALK_WORDS: TranscriptWord[] = [
  word("Hello", 0, 0.4), word("there.", 0.5, 0.9),
  word("We", 1.5, 1.7), word("should", 1.8, 2.2), word("probably", 2.3, 2.9), word("skip", 3.0, 3.3), word("this", 3.4, 3.6), word("part.", 3.7, 4.2),
  word("Thanks", 5.0, 5.4), word("for", 5.5, 5.6), word("watching.", 5.7, 6.3),
];

export const transcriptOf = (assetId: string, words: TranscriptWord[]): Transcript => ({
  version: TRANSCRIPT_VERSION, assetId, language: "en", model: "test", words,
});

export interface TranscriptHarness {
  editor: Editor;
  tools: AgentToolRegistry;
  store: ReturnType<typeof createMemoryTranscriptStore>;
  call(name: string, args?: unknown): Promise<ToolResult>;
  data<T = Record<string, unknown>>(name: string, args?: unknown): Promise<T>;
  failure(name: string, args?: unknown): Promise<{ error: string; hint: string }>;
}

export function setupTranscript(options: { assets?: MediaAssetInfo[]; transcriber?: TranscriptDeps["transcriber"]; words?: TranscriptWord[] } = {}): TranscriptHarness {
  const { editor } = makeEditor({ assets: options.assets ?? ASSETS });
  const store = createMemoryTranscriptStore();
  store.save(transcriptOf("a1", options.words ?? TALK_WORDS));
  const tools = new Map(createAgentTools());
  for (const tool of createTranscriptTools({ store, ...(options.transcriber ? { transcriber: options.transcriber } : {}) })) tools.set(tool.name, tool);
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

/** Source ranges (seconds) that the clips of `assetId` play, merged. */
export function playedSource(editor: Editor, assetId: string): Array<{ start: number; end: number }> {
  const ranges = allElements(editor.tracks())
    .map((l) => l.element)
    .flatMap((e) => {
      if (!("mediaId" in e) || e.mediaId !== assetId) return [];
      const rate = "retime" in e && e.retime ? e.retime.rate : 1;
      return [{ start: e.trimStart / TICKS_PER_SECOND, end: (e.trimStart + e.duration * rate) / TICKS_PER_SECOND }];
    })
    .sort((a, b) => a.start - b.start);
  const merged: Array<{ start: number; end: number }> = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    if (last && r.start <= last.end + 1e-6) last.end = Math.max(last.end, r.end);
    else merged.push({ ...r });
  }
  return merged;
}

/** How much of [start, end] (source seconds) is still played. */
export function coverage(played: ReadonlyArray<{ start: number; end: number }>, start: number, end: number): number {
  return played.reduce((sum, r) => sum + Math.max(0, Math.min(r.end, end) - Math.max(r.start, start)), 0);
}
