import { fail } from "./env";
import { EDIT_TOOLS } from "./tools-edit";
import { INSERT_TOOLS } from "./tools-insert";
import { PROJECT_TOOLS } from "./tools-project";
import { PROP_TOOLS } from "./tools-props";
import { READ_TOOLS } from "./tools-read";
import type { AgentTool, AgentToolRegistry, ToolContext, ToolResult } from "./types";
import { didYouMean } from "./validate";

/** Every tool an agent can use, keyed by name. Tools are stateless; share one registry freely. */
export function createAgentTools(): AgentToolRegistry {
  const all = [...READ_TOOLS, ...INSERT_TOOLS, ...EDIT_TOOLS, ...PROP_TOOLS, ...PROJECT_TOOLS];
  const registry = new Map<string, AgentTool>();
  for (const tool of all) {
    if (registry.has(tool.name)) throw new Error(`Duplicate agent tool name "${tool.name}"`);
    registry.set(tool.name, tool);
  }
  return registry;
}

/** Looks up and runs a tool by name. Unknown names and thrown errors become `{ ok: false }` results. */
export async function callTool(input: {
  tools: AgentToolRegistry; name: string; args: unknown; ctx: ToolContext;
}): Promise<ToolResult> {
  const tool = input.tools.get(input.name);
  if (!tool) {
    const near = didYouMean(input.name, [...input.tools.keys()]);
    return fail(`Unknown tool "${input.name}".`, near ? `Did you mean "${near}"?` : `Available tools: ${[...input.tools.keys()].join(", ")}.`);
  }
  try {
    return await tool.run(input.args, input.ctx);
  } catch (error) {
    return fail(`Tool "${input.name}" crashed: ${error instanceof Error ? error.message : String(error)}`, "Retry with different arguments.");
  }
}
