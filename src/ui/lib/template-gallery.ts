import type { ProjectTemplate, TemplateAspect, TemplateCategory } from "#/engine/templates";
import { previewUrls } from "#/templates";

/** What a gallery card needs from a template. Plain data, so filtering and layout logic stay testable without React. */
export interface TemplateCardData {
  id: string;
  name: string;
  description: string;
  category: TemplateCategory;
  tags: string[];
  aspect: TemplateAspect;
  durationSeconds: number;
  slotCount: number;
  textCount: number;
  poster: string | null;
  video: string | null;
}

export type CategoryFilter = TemplateCategory | "all";

/** At most this many preview videos run at once; the rest show their poster. */
export const MAX_PLAYING_PREVIEWS = 4;

export const CATEGORY_LABELS: Record<TemplateCategory, string> = {
  launch: "Launch",
  announcement: "Announcement",
  explainer: "Explainer",
  showcase: "Showcase",
  list: "List",
  "social-proof": "Social proof",
  creator: "Creator",
  update: "Update",
};

export function toCardData(template: ProjectTemplate): TemplateCardData {
  const urls = previewUrls(template);
  return {
    id: template.id,
    name: template.name,
    description: template.description,
    category: template.category,
    tags: [...template.tags],
    aspect: template.canvas.aspect,
    durationSeconds: template.durationSeconds,
    slotCount: template.slots.length + (template.repeat ?? []).reduce((n, group) => n + group.slots.length, 0),
    textCount: template.texts.length,
    poster: urls?.poster ?? null,
    video: urls?.video ?? null,
  };
}

export function categoryLabel(category: string): string {
  return (CATEGORY_LABELS as Record<string, string>)[category] ?? category;
}

/** Categories that at least one card has, in the order they first appear (so the chips follow the gallery order). */
export function categoriesOf(cards: ReadonlyArray<TemplateCardData>): TemplateCategory[] {
  return [...new Set(cards.map((card) => card.category))];
}

export function filterCards(cards: ReadonlyArray<TemplateCardData>, filter: { category: CategoryFilter; query: string }): TemplateCardData[] {
  const terms = filter.query.toLowerCase().split(/\s+/).filter(Boolean);
  return cards.filter((card) => {
    if (filter.category !== "all" && card.category !== filter.category) return false;
    if (terms.length === 0) return true;
    const haystack = [card.name, card.description, categoryLabel(card.category), card.aspect, ...card.tags].join(" ").toLowerCase();
    return terms.every((term) => haystack.includes(term));
  });
}

/** `0:25`, `1:05`. */
export function durationBadge(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

export function summaryLine(card: Pick<TemplateCardData, "slotCount" | "textCount">): string {
  const clips = `${card.slotCount} ${card.slotCount === 1 ? "slot" : "slots"}`;
  const texts = `${card.textCount} ${card.textCount === 1 ? "text" : "texts"}`;
  return `${clips} · ${texts}`;
}

/**
 * Which previews should play: the first `limit` visible cards in gallery order. `order` is the full card order,
 * `visible` the ids currently on screen.
 */
export function pickPlaying(order: ReadonlyArray<string>, visible: ReadonlySet<string>, limit: number = MAX_PLAYING_PREVIEWS): Set<string> {
  const playing = new Set<string>();
  for (const id of order) {
    if (playing.size >= limit) break;
    if (visible.has(id)) playing.add(id);
  }
  return playing;
}

/** Previews are off when the person paused them or the system asks for reduced motion. */
export function previewsPaused(input: { pausedPref: boolean; reducedMotion: boolean }): boolean {
  return input.pausedPref || input.reducedMotion;
}
