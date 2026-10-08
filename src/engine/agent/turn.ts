import type { Editor } from "#/engine/editor";
import { callTool } from "./registry";
import type { AgentToolRegistry, ToolContext, ToolResult } from "./types";

/**
 * Runs `fn` as one undo step. Everything the tools do inside it collapses into a single history entry on success;
 * if `fn` throws, the document, selection and history are restored exactly and the error is rethrown.
 * Safe to nest: only the outermost turn defines the undo step.
 */
export async function runAgentTurn<T>(editor: Editor, label: string, fn: () => T | Promise<T>): Promise<T> {
  editor.beginTransaction(label);
  try {
    const value = await fn();
    editor.commitTransaction();
    return value;
  } catch (error) {
    editor.rollbackTransaction();
    throw error;
  }
}

export interface ToolCall {
  name: string;
  args: unknown;
}

export interface ToolTurnResult {
  results: Array<{ call: ToolCall; result: ToolResult }>;
  /** True when an atomic turn hit a failing call and everything was rolled back. */
  rolledBack: boolean;
}

/**
 * Runs tool calls in order as one turn (one undo step). With `atomic` the first failing call rolls the whole turn
 * back and stops; otherwise failures are reported and the turn continues with what succeeded.
 */
export async function runToolTurn(input: {
  editor: Editor; tools: AgentToolRegistry; ctx: ToolContext; label: string; calls: ReadonlyArray<ToolCall>; atomic?: boolean;
}): Promise<ToolTurnResult> {
  const results: ToolTurnResult["results"] = [];
  let rolledBack = false;
  input.editor.beginTransaction(input.label);
  try {
    for (const call of input.calls) {
      const result = await callTool({ tools: input.tools, name: call.name, args: call.args, ctx: input.ctx });
      results.push({ call, result });
      if (!result.ok && input.atomic) {
        rolledBack = true;
        break;
      }
    }
  } catch (error) {
    input.editor.rollbackTransaction();
    throw error;
  }
  if (rolledBack) input.editor.rollbackTransaction();
  else input.editor.commitTransaction();
  return { results, rolledBack };
}
