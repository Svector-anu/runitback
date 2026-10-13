import { fail } from "./env";
import { EDIT_TOOLS } from "./tools-edit";
import { INSERT_TOOLS } from "./tools-insert";
import { PROJECT_TOOLS } from "./tools-project";
import { PROP_TOOLS } from "./tools-props";
import { FRAME_TOOLS } from "./tools-frame";
import { TEXT_TOOLS } from "./tools-text";
import { COLOR_TOOLS } from "./tools-color";
import { VFX_TOOLS } from "./tools-vfx";
import { TRANSITION_TOOLS } from "./tools-transitions";
import { READ_TOOLS } from "./tools-read";
import { createReferenceTools, type ReferenceDeps } from "./tools-reference";
import type { AgentTool, AgentToolRegistry, ToolContext, ToolResult } from "./types";
import { didYouMean } from "./validate";

export interface AgentToolOptions {
  /** Enables the reference-intelligence tools; the app supplies profile storage and the analysis source. Omitted = tools absent. */
  reference?: ReferenceDeps;
}

/** Every tool an agent can use, keyed by name. Share one registry per session: the reference tools keep state in their injected store. */
export function createAgentTools(options: AgentToolOptions = {}): AgentToolRegistry {
  const reference = options.reference ? createReferenceTools(options.reference) : [];
  const all = [...READ_TOOLS, ...INSERT_TOOLS, ...EDIT_TOOLS, ...PROP_TOOLS, ...TRANSITION_TOOLS, ...COLOR_TOOLS, ...VFX_TOOLS, ...TEXT_TOOLS, ...FRAME_TOOLS, ...PROJECT_TOOLS, ...reference];
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
