import {
  TEMPLATE_ASPECTS, TEMPLATE_CATEGORIES, TemplateApplyError, applyTemplateToEditor, describeTemplate, summarizeTemplate,
  type ProjectTemplate, type RepeatItemInput, type TemplateInputs,
} from "#/engine/templates";
import { defineTool, ok, ToolError, type ToolEnv } from "./env";
import type { AgentTool, JsonSchema } from "./types";
import { didYouMean } from "./validate";

/** The catalogue the agent can choose from. The app supplies the shipped templates; tests supply their own. */
export interface TemplateDeps {
  list(): ReadonlyArray<ProjectTemplate>;
}

const TEMPLATE_ID: JsonSchema = { type: "string", description: "Template id from list_templates." };
const ID_MAP = (what: string): JsonSchema => ({ type: "object", additionalProperties: true, description: what });

function requireTemplate(deps: TemplateDeps, templateId: string): ProjectTemplate {
  const found = deps.list().find((t) => t.id === templateId);
  if (found) return found;
  const ids = deps.list().map((t) => t.id);
  const near = didYouMean(templateId, ids);
  throw new ToolError(`No template with id "${templateId}".`, `${near ? `Did you mean "${near}"? ` : ""}Call list_templates. Known ids: ${ids.join(", ") || "(none)"}.`);
}

function stringMap(value: unknown, field: string, valid: ReadonlyArray<string>, hint: string): Record<string, string> {
  if (value === undefined) return {};
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new ToolError(`"${field}" must be an object mapping ids to strings.`, hint);
  const out: Record<string, string> = {};
  for (const [key, v] of Object.entries(value)) {
    if (typeof v !== "string") throw new ToolError(`"${field}.${key}" must be a string, got ${typeof v}.`, hint);
    if (!valid.includes(key)) {
      const near = didYouMean(key, valid);
      throw new ToolError(`"${key}" is not a valid ${field} id for this template.`, `${near ? `Did you mean "${near}"? ` : ""}Valid ids: ${valid.join(", ") || "(none)"}.`);
    }
    out[key] = v;
  }
  return out;
}

function requireKnownAssets(env: ToolEnv, ids: ReadonlyArray<string>): void {
  for (const id of ids) {
    if (!env.editor.getAsset(id)) {
      throw new ToolError(`No asset with id "${id}".`, `Call list_assets. Known ids: ${env.doc.assets.map((a) => a.id).join(", ") || "(no assets imported)"}.`);
    }
  }
}

function repeatInputs(template: ProjectTemplate, value: unknown): Record<string, RepeatItemInput[]> {
  if (value === undefined) return {};
  const groups = template.repeat ?? [];
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ToolError('"repeat" must be an object mapping a repeat group id to a list of items.', `Repeat groups: ${groups.map((g) => g.id).join(", ") || "none"}.`);
  }
  const out: Record<string, RepeatItemInput[]> = {};
  for (const [groupId, items] of Object.entries(value)) {
    const group = groups.find((g) => g.id === groupId);
    if (!group) throw new ToolError(`"${groupId}" is not a repeat group of this template.`, `Repeat groups: ${groups.map((g) => g.id).join(", ") || "none"}.`);
    if (!Array.isArray(items)) throw new ToolError(`repeat.${groupId} must be a list of { slots, texts } items.`, `Each item fills ${group.slots.map((s) => s.id).join(", ") || "no slots"} and ${group.texts.map((t) => t.id).join(", ") || "no texts"}.`);
    out[groupId] = items.map((item, i): RepeatItemInput => {
      const raw = (typeof item === "object" && item !== null ? item : {}) as Record<string, unknown>;
      const field = `repeat.${groupId}[${i}]`;
      const hint = `Item fields: slots {${group.slots.map((s) => s.id).join(", ")}}, texts {${group.texts.map((t) => t.id).join(", ")}}.`;
      return {
        slots: stringMap(raw["slots"], `${field}.slots`, group.slots.map((s) => s.id), hint),
        texts: stringMap(raw["texts"], `${field}.texts`, group.texts.map((t) => t.id), hint),
      };
    });
  }
  return out;
}

export function createTemplateTools(deps: TemplateDeps): AgentTool[] {
  const listTemplates = defineTool<{ category?: string; aspect?: string; query?: string }>({
    name: "list_templates",
    description:
      "List the ready-made video templates (product launch, kinetic text, listicle, testimonial, ...). Each row has id, name, category, aspect, length and the media slots to fill. Filter by `category`, `aspect` or a `query` word. Read-only. Next: describe_template, then apply_template.",
    inputSchema: {
      type: "object",
      properties: {
        category: { type: "string", enum: [...TEMPLATE_CATEGORIES] },
        aspect: { type: "string", enum: [...TEMPLATE_ASPECTS] },
        query: { type: "string", description: "Matches name, description and tags." },
      },
    },
    readOnly: true,
    run(input) {
      const query = input.query?.trim().toLowerCase();
      const rows = deps.list().filter((t) =>
        (input.category === undefined || t.category === input.category)
        && (input.aspect === undefined || t.canvas.aspect === input.aspect)
        && (!query || `${t.name} ${t.description} ${t.tags.join(" ")}`.toLowerCase().includes(query)));
      return ok(`${rows.length} template(s).`, { templates: rows.map(summarizeTemplate) });
    },
  });

  const describe = defineTool<{ templateId: string }>({
    name: "describe_template",
    description:
      "Everything needed to fill one template: media slots (kind, expected length, optional), texts with their defaults and character limits, and repeat groups (a list of items, each with its own slots and texts). Read-only. Then call apply_template.",
    inputSchema: { type: "object", properties: { templateId: TEMPLATE_ID }, required: ["templateId"] },
    readOnly: true,
    run(input) {
      const template = requireTemplate(deps, input.templateId);
      const description = describeTemplate(template);
      return ok(`${template.name}: ${description.slots.length} slot(s), ${description.texts.length} text(s), ${description.durationSeconds}s ${description.aspect}.`, description);
    },
  });

  const apply = defineTool<{ templateId: string; slots?: unknown; texts?: unknown; repeat?: unknown; replace?: boolean }>({
    name: "apply_template",
    description:
      "Build a whole video from a template in ONE undo step: sets the canvas and frame rate, places your clips on tracks trimmed to the template's beats, adds styled and animated text, filters and transitions. `slots` maps slot id -> asset id (from list_assets); `texts` maps text id -> the words to show (omitted texts keep the template's placeholder words, so always pass the real ones); `repeat` maps a repeat group id -> a list of items, each { slots, texts }. Every required slot must be mapped. Clips shorter than their beat are held, looped or end early, and the result lists warnings. The timeline must be empty unless `replace` is true, which clears it first. Changes the canvas, so it needs an approved plan.",
    inputSchema: {
      type: "object",
      properties: {
        templateId: TEMPLATE_ID,
        slots: ID_MAP("Slot id -> asset id, e.g. { \"clip-1\": \"asset-abc\" }."),
        texts: ID_MAP("Text id -> words to show, e.g. { \"headline\": \"Ship faster\" }."),
        repeat: ID_MAP("Repeat group id -> list of { slots, texts } items."),
        replace: { type: "boolean", description: "Clear the current timeline first (undoable). Default false." },
      },
      required: ["templateId"],
    },
    readOnly: false,
    destructive: true,
    run(input, env) {
      env.requireProject();
      const template = requireTemplate(deps, input.templateId);
      const inputs: TemplateInputs = {
        slots: stringMap(input.slots, "slots", template.slots.map((s) => s.id), "Call describe_template for the slot ids."),
        texts: stringMap(input.texts, "texts", template.texts.map((t) => t.id), "Call describe_template for the text ids."),
        repeat: repeatInputs(template, input.repeat),
      };
      requireKnownAssets(env, [
        ...Object.values(inputs.slots ?? {}),
        ...Object.values(inputs.repeat ?? {}).flatMap((items) => items.flatMap((item) => Object.values(item.slots ?? {}))),
      ]);
      try {
        const result = applyTemplateToEditor(env.editor, template, inputs, { replace: input.replace === true, requireAllSlots: true });
        const note = result.warnings.length > 0 ? ` ${result.warnings.length} warning(s).` : "";
        return ok(
          `Applied "${template.name}": ${result.elementIds.length} clip(s), ${result.durationSeconds}s at ${result.canvas.width}x${result.canvas.height} ${result.fps}fps.${note}`,
          { templateId: result.templateId, durationSeconds: result.durationSeconds, canvas: result.canvas, fps: result.fps, clips: result.elementIds.length, warnings: result.warnings.map((w) => w.message) },
        );
      } catch (error) {
        if (error instanceof TemplateApplyError) throw new ToolError(error.message, error.hint);
        throw error;
      }
    },
  });

  return [listTemplates, describe, apply];
}
