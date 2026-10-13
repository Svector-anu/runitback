import { PARAM } from "#/engine/model";
import { CAPTION_STYLE_PRESETS, TEXT_STYLE_PRESETS } from "./presets";
import type { ProjectTemplate, SlotKind, TemplateAspect, TemplateCategory } from "./types";

export interface SlotSummary {
  id: string;
  kind: SlotKind;
  label: string;
  optional: boolean;
  expectedSeconds?: number;
  hint?: string;
}

export interface TextSummary {
  id: string;
  label: string;
  default: string;
  maxChars?: number;
}

export interface RepeatSummary {
  id: string;
  label: string;
  min: number;
  max: number;
  itemSeconds: number;
  slots: SlotSummary[];
  texts: TextSummary[];
}

export interface TemplateSummary {
  id: string;
  name: string;
  category: TemplateCategory;
  aspect: TemplateAspect;
  durationSeconds: number;
  slots: SlotSummary[];
}

export interface TemplateDescription extends TemplateSummary {
  description: string;
  tags: string[];
  fps: number;
  texts: TextSummary[];
  repeat: RepeatSummary[];
  /** Whether the template styles caption cues it is given. */
  captions: boolean;
}

const slotSummary = (slot: ProjectTemplate["slots"][number]): SlotSummary => ({
  id: slot.id, kind: slot.kind, label: slot.label, optional: slot.optional === true,
  ...(slot.expectedSeconds !== undefined ? { expectedSeconds: slot.expectedSeconds } : {}), ...(slot.hint ? { hint: slot.hint } : {}),
});

const textSummary = (text: ProjectTemplate["texts"][number]): TextSummary => ({
  id: text.id, label: text.label, default: text.default, ...(text.maxChars !== undefined ? { maxChars: text.maxChars } : {}),
});

/** The compact listing row: what a person or model needs to pick a template. */
export function summarizeTemplate(template: ProjectTemplate): TemplateSummary {
  return {
    id: template.id, name: template.name, category: template.category, aspect: template.canvas.aspect,
    durationSeconds: template.durationSeconds, slots: template.slots.map(slotSummary),
  };
}

/** Everything needed to fill a template in: slots, texts with their defaults, and repeat groups. */
export function describeTemplate(template: ProjectTemplate): TemplateDescription {
  return {
    ...summarizeTemplate(template),
    description: template.description, tags: [...template.tags], fps: template.canvas.fps, texts: template.texts.map(textSummary),
    repeat: (template.repeat ?? []).map((g) => ({
      id: g.id, label: g.label, min: g.min, max: g.max, itemSeconds: g.itemSeconds, slots: g.slots.map(slotSummary), texts: g.texts.map(textSummary),
    })),
    captions: template.captions !== undefined,
  };
}

/** Font families the template's text styles use, so a host can load them before the first render or export. */
export function templateFontFamilies(template: ProjectTemplate): string[] {
  const styles = new Set<string>([...template.texts, ...(template.repeat ?? []).flatMap((g) => g.texts)].map((t) => t.style));
  if (template.captions) styles.add(CAPTION_STYLE_PRESETS[template.captions.style]?.text ?? "caption");
  const families = new Set<string>();
  for (const id of styles) {
    const family = TEXT_STYLE_PRESETS[id]?.params[PARAM.fontFamily];
    if (typeof family === "string") families.add(family);
  }
  for (const text of [...template.texts, ...(template.repeat ?? []).flatMap((g) => g.texts)]) {
    const family = text.overrides?.[PARAM.fontFamily];
    if (typeof family === "string") families.add(family);
  }
  return [...families];
}
