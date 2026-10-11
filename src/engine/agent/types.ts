import type { Editor } from "#/engine/editor";

/** Minimal JSON Schema subset used to describe tool inputs to a model. */
export interface JsonSchema {
  type?: "object" | "string" | "number" | "integer" | "boolean" | "array" | "null";
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  enum?: ReadonlyArray<string | number | boolean>;
  minimum?: number;
  maximum?: number;
  additionalProperties?: boolean;
  oneOf?: JsonSchema[];
}

export interface ToolImage {
  mediaType: "image/jpeg" | "image/png";
  base64: string;
  /** What the picture shows, e.g. "frame at 3.20s". */
  caption?: string;
}

export type ToolResult =
  | { ok: true; summary: string; data?: unknown; images?: ToolImage[] }
  /** Errors are written for a model to read: say what was wrong and how to fix the call. */
  | { ok: false; error: string; hint?: string };

export interface ToolContext {
  editor: Editor;
  /** Wall clock in ms for playback anchoring; injected so tools are deterministic in tests. */
  nowMs(): number;
}

/**
 * One capability the agent can use. Tools are the only way an agent touches a project:
 * they validate input, run editor commands, and report what changed in plain structured data.
 * Times at this boundary are SECONDS (floats) and ids are element ids, never ticks or track/element pairs.
 */
export interface AgentTool {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  /** True when the tool never changes the project (safe to call freely, never creates history). */
  readOnly: boolean;
  /**
   * True when one call can remove or rewrite more than the single element it names, or change project-wide state
   * (history, canvas, whole tracks, bulk imports). Such a call needs an approved plan; it never gets the unplanned allowance.
   */
  destructive?: boolean;
  run(input: unknown, ctx: ToolContext): ToolResult | Promise<ToolResult>;
}

export type AgentToolRegistry = ReadonlyMap<string, AgentTool>;
