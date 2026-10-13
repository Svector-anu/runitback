import type { MediaAssetInfo } from "#/engine/model";
import type { RepeatItemInput, SlotKind, TemplateDescription, TemplateInputs } from "#/engine/templates";

type SlotSummary = TemplateDescription["slots"][number];
type RepeatSummary = TemplateDescription["repeat"][number];

type FillAsset = Pick<MediaAssetInfo, "id" | "type">;

/** A video or image slot takes either (an image is shown as a still); an audio slot takes audio only. */
export function slotAccepts(kind: SlotKind, assetType: MediaAssetInfo["type"]): boolean {
  return kind === "audio" ? assetType === "audio" : assetType === "video" || assetType === "image";
}

export function assetsForSlot<T extends FillAsset>(kind: SlotKind, assets: ReadonlyArray<T>): T[] {
  return assets.filter((asset) => slotAccepts(kind, asset.type));
}

/**
 * Hands each empty slot an unused imported asset of the right kind, in slot order. An exact match (video for a video
 * slot) wins over a still image. Slots that already have a choice are kept, and their assets count as used.
 */
export function suggestSlotAssets(
  slots: ReadonlyArray<Pick<SlotSummary, "id" | "kind">>, assets: ReadonlyArray<FillAsset>, current: Readonly<Record<string, string>> = {},
): Record<string, string> {
  const result: Record<string, string> = { ...current };
  const used = new Set(Object.values(result).filter(Boolean));
  for (const slot of slots) {
    if (result[slot.id]) continue;
    const candidates = assetsForSlot(slot.kind, assets).filter((asset) => !used.has(asset.id));
    const pick = candidates.find((asset) => asset.type === slot.kind) ?? candidates[0];
    if (pick) {
      result[slot.id] = pick.id;
      used.add(pick.id);
    }
  }
  return result;
}

export interface RepeatFill {
  count: number;
  items: Array<{ slots: Record<string, string>; texts: Record<string, string> }>;
}

export interface FillState {
  /** Slot id to asset id; "" means empty. */
  slots: Record<string, string>;
  /** Text id to the words in its field. */
  texts: Record<string, string>;
  repeat: Record<string, RepeatFill>;
  /** Slots the person set by hand, so a later import never overwrites their choice. */
  touched: ReadonlySet<string>;
}

const emptyItem = (): RepeatFill["items"][number] => ({ slots: {}, texts: {} });

function itemsFor(count: number, existing: RepeatFill["items"]): RepeatFill["items"] {
  return Array.from({ length: count }, (_, index) => existing[index] ?? emptyItem());
}

export function initialFillState(description: TemplateDescription, assets: ReadonlyArray<FillAsset>): FillState {
  const slots = suggestSlotAssets(description.slots, assets);
  const texts = Object.fromEntries(description.texts.map((text) => [text.id, text.default]));
  const repeat: Record<string, RepeatFill> = {};
  for (const group of description.repeat) repeat[group.id] = { count: group.min, items: itemsFor(group.min, []) };
  return { slots, texts, repeat, touched: new Set() };
}

/** After new media arrives (an import from the dialog), fills slots that are still empty and were never touched. */
export function fillUntouchedSlots(description: TemplateDescription, state: FillState, assets: ReadonlyArray<FillAsset>): FillState {
  const open = description.slots.filter((slot) => !state.slots[slot.id] && !state.touched.has(slot.id));
  const suggested = suggestSlotAssets(open, assets, Object.fromEntries(Object.entries(state.slots).filter(([, value]) => value)));
  return { ...state, slots: { ...state.slots, ...Object.fromEntries(open.map((slot) => [slot.id, suggested[slot.id] ?? ""])) } };
}

export function setSlot(state: FillState, slotId: string, assetId: string): FillState {
  return { ...state, slots: { ...state.slots, [slotId]: assetId }, touched: new Set([...state.touched, slotId]) };
}

export function setText(state: FillState, textId: string, value: string): FillState {
  return { ...state, texts: { ...state.texts, [textId]: value } };
}

export function setRepeatCount(state: FillState, group: RepeatSummary, count: number): FillState {
  const clamped = Math.min(group.max, Math.max(group.min, Math.round(count)));
  const current = state.repeat[group.id] ?? { count: group.min, items: [] };
  return { ...state, repeat: { ...state.repeat, [group.id]: { count: clamped, items: itemsFor(clamped, current.items) } } };
}

export function setRepeatItem(state: FillState, groupId: string, index: number, patch: { slotId?: string; assetId?: string; textId?: string; value?: string }): FillState {
  const group = state.repeat[groupId];
  const item = group?.items[index];
  if (!group || !item) return state;
  const next = {
    slots: patch.slotId !== undefined ? { ...item.slots, [patch.slotId]: patch.assetId ?? "" } : item.slots,
    texts: patch.textId !== undefined ? { ...item.texts, [patch.textId]: patch.value ?? "" } : item.texts,
  };
  return { ...state, repeat: { ...state.repeat, [groupId]: { ...group, items: group.items.map((existing, i) => (i === index ? next : existing)) } } };
}

const nonEmpty = (record: Readonly<Record<string, string>>): Record<string, string> =>
  Object.fromEntries(Object.entries(record).filter(([, value]) => value.trim() !== ""));

/** Turns the form into `applyTemplateToEditor` inputs. Text left at its default (or cleared) is omitted so the template's own words are used. */
export function buildTemplateInputs(description: TemplateDescription, state: FillState): TemplateInputs {
  const defaults = new Map(description.texts.map((text) => [text.id, text.default]));
  const texts = Object.fromEntries(Object.entries(nonEmpty(state.texts)).filter(([id, value]) => value !== defaults.get(id)));
  const repeat: Record<string, RepeatItemInput[]> = {};
  for (const group of description.repeat) {
    const fill = state.repeat[group.id];
    if (fill) repeat[group.id] = fill.items.slice(0, fill.count).map((item) => ({ slots: nonEmpty(item.slots), texts: nonEmpty(item.texts) }));
  }
  return { slots: nonEmpty(state.slots), texts, ...(Object.keys(repeat).length > 0 ? { repeat } : {}) };
}

/** Labels of required slots that have no media yet, for the plain "these parts stay empty" note. */
export function emptyRequiredSlots(description: TemplateDescription, state: FillState): string[] {
  const labels = description.slots.filter((slot) => !slot.optional && !state.slots[slot.id]).map((slot) => slot.label);
  for (const group of description.repeat) {
    const fill = state.repeat[group.id];
    if (!fill) continue;
    fill.items.slice(0, fill.count).forEach((item, index) => {
      for (const slot of group.slots) if (!slot.optional && !item.slots[slot.id]) labels.push(`${group.label} ${index + 1}: ${slot.label}`);
    });
  }
  return labels;
}

/** Placeholder for a repeat-group text field: the default with `{n}` and `{count}` filled in. */
export function repeatTextPlaceholder(template: string, index: number, count: number): string {
  return template.replaceAll("{n}", String(index + 1)).replaceAll("{count}", String(count));
}
