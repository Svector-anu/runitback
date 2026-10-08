import { expect } from "vitest";
import { callTool, createAgentTools, type ToolResult } from "#/engine/agent";
import type { Editor } from "#/engine/editor";
import type { MediaAssetInfo } from "#/engine/model";
import { currentScene } from "#/engine/commands";
import { makeEditor, sec, videoAsset } from "./helpers";

export const ASSETS: MediaAssetInfo[] = [
  videoAsset("a1", 10),
  videoAsset("a2", 8),
  videoAsset("a3", 6),
  { id: "music", name: "music.mp3", type: "audio", size: 1, lastModified: 0, duration: sec(30) },
  { id: "photo", name: "photo.png", type: "image", size: 1, lastModified: 0, width: 1000, height: 800 },
];

export interface AgentHarness {
  editor: Editor;
  call(name: string, args?: unknown): Promise<ToolResult>;
  /** Calls a tool, asserts success and returns its `data`. */
  data<T = Record<string, unknown>>(name: string, args?: unknown): Promise<T>;
  /** Calls a tool, asserts failure and returns the error and hint. */
  failure(name: string, args?: unknown): Promise<{ error: string; hint: string }>;
}

export function setupAgent(assets: MediaAssetInfo[] = ASSETS): AgentHarness {
  const { editor } = makeEditor({ assets });
  const tools = createAgentTools();
  const ctx = { editor, nowMs: () => 0 };
  const call = (name: string, args: unknown = {}): Promise<ToolResult> => callTool({ tools, name, args, ctx });
  return {
    editor,
    call,
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

export const tracksOf = (editor: Editor) => currentScene(editor.getState().doc).tracks;

/** Document shape without ids, for comparing two edit histories that minted ids in a different order. */
export function normalized(editor: Editor): string {
  const { tracks } = currentScene(editor.getState().doc);
  const strip = (_key: string, value: unknown): unknown => (_key === "id" ? undefined : value);
  return JSON.stringify({ overlay: tracks.overlay, main: tracks.main, audio: tracks.audio, settings: editor.getState().doc.settings }, strip);
}

export interface InsertedData { elementId: string; trackId: string; start: number; end: number; duration: number; trackCreated: boolean }

export interface ElementDetail {
  params: Record<string, unknown>;
  animations: Record<string, { keyframes: Array<{ id: string; time: number; value?: number }> }>;
  effects: Array<{ id: string; type: string; enabled: boolean; params: Record<string, unknown> }>;
  masks: Array<{ id: string; type: string; params: Record<string, unknown> }>;
  shape?: string;
  sourceDuration?: number;
}
