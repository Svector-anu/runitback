import { createTemplateTools, type AgentTool } from "#/engine/agent";
import { listTemplates } from "#/templates";

/** list_templates, describe_template and apply_template over the templates shipped with the app. */
export function createAppTemplateTools(): AgentTool[] {
  return createTemplateTools({ list: listTemplates });
}
