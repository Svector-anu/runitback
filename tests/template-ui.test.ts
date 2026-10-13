import { describe, expect, it } from "vitest";
import { describeTemplate } from "../src/engine/templates";
import { getTemplate, listTemplates } from "../src/templates";
import { INSPIRATION } from "../src/ui/pages/templates/templates-content";
import {
  assetsForSlot, buildTemplateInputs, emptyRequiredSlots, fillUntouchedSlots, initialFillState, repeatTextPlaceholder, setRepeatCount, setRepeatItem,
  setSlot, setText, slotAccepts, suggestSlotAssets,
} from "../src/ui/lib/template-fill";
import { categoriesOf, durationBadge, filterCards, pickPlaying, previewsPaused, summaryLine, toCardData } from "../src/ui/lib/template-gallery";

const cards = listTemplates().map(toCardData);
const need = <T>(value: T | undefined): T => {
  if (value === undefined) throw new Error("missing fixture");
  return value;
};
const describeById = (id: string) => describeTemplate(need(getTemplate(id)));

describe("gallery filters", () => {
  it("lists all thirteen templates with previews", () => {
    expect(cards).toHaveLength(13);
    for (const card of cards) {
      expect(card.poster).toBe(`/templates/${card.id}.webp`);
      expect(card.video).toBe(`/templates/${card.id}.mp4`);
    }
  });

  it("filters by category, by search terms across name, tags and aspect, and by both", () => {
    expect(filterCards(cards, { category: "all", query: "" })).toHaveLength(13);
    expect(filterCards(cards, { category: "list", query: "" }).map((c) => c.id)).toEqual(["listicle"]);
    expect(filterCards(cards, { category: "all", query: "9:16" }).length).toBeGreaterThanOrEqual(3);
    expect(filterCards(cards, { category: "all", query: "  saas  launch " }).map((c) => c.id)).toEqual(["product-launch"]);
    expect(filterCards(cards, { category: "creator", query: "launch" })).toEqual([]);
  });

  it("derives category chips from the cards in first-seen order", () => {
    expect(categoriesOf(cards)[0]).toBe("launch");
    expect(new Set(categoriesOf(cards)).size).toBe(categoriesOf(cards).length);
  });

  it("formats badges and summaries", () => {
    expect(durationBadge(25)).toBe("0:25");
    expect(durationBadge(65.4)).toBe("1:05");
    expect(summaryLine({ slotCount: 1, textCount: 2 })).toBe("1 slot · 2 texts");
  });
});

describe("preview budget", () => {
  const order = ["a", "b", "c", "d", "e", "f"];
  it("plays the first four visible cards in gallery order", () => {
    expect([...pickPlaying(order, new Set(["f", "e", "d", "c", "b", "a"]))]).toEqual(["a", "b", "c", "d"]);
    expect([...pickPlaying(order, new Set(["c", "e", "f"]))]).toEqual(["c", "e", "f"]);
    expect(pickPlaying(order, new Set())).toEqual(new Set());
  });
  it("pauses on the preference or on reduced motion", () => {
    expect(previewsPaused({ pausedPref: false, reducedMotion: false })).toBe(false);
    expect(previewsPaused({ pausedPref: true, reducedMotion: false })).toBe(true);
    expect(previewsPaused({ pausedPref: false, reducedMotion: true })).toBe(true);
  });
});

describe("slot matching", () => {
  const assets = [
    { id: "img", type: "image" as const }, { id: "v1", type: "video" as const }, { id: "v2", type: "video" as const }, { id: "song", type: "audio" as const },
  ];
  it("accepts video or image for visual slots and audio only for audio slots", () => {
    expect(slotAccepts("video", "image")).toBe(true);
    expect(slotAccepts("image", "video")).toBe(true);
    expect(slotAccepts("video", "audio")).toBe(false);
    expect(slotAccepts("audio", "video")).toBe(false);
    expect(assetsForSlot("audio", assets).map((a) => a.id)).toEqual(["song"]);
  });
  it("prefers exact kind, never reuses an asset, and keeps existing choices", () => {
    const slots = [{ id: "a", kind: "video" as const }, { id: "b", kind: "video" as const }, { id: "c", kind: "video" as const }, { id: "m", kind: "audio" as const }, { id: "logo", kind: "image" as const }];
    expect(suggestSlotAssets(slots, assets)).toEqual({ a: "v1", b: "v2", c: "img", m: "song" });
    expect(suggestSlotAssets(slots, assets, { b: "v1" })).toEqual({ b: "v1", a: "v2", c: "img", m: "song" });
    expect(suggestSlotAssets(slots.slice(0, 1), [])).toEqual({});
  });
  it("fills only untouched empty slots after an import", () => {
    const description = describeById("product-launch");
    let state = initialFillState(description, []);
    state = setSlot(state, "rec-1", "");
    const next = fillUntouchedSlots(description, state, [{ id: "v1", type: "video" }, { id: "v2", type: "video" }]);
    expect(next.slots["rec-1"]).toBe("");
    expect(next.slots["rec-2"]).toBe("v1");
    expect(next.slots["rec-3"]).toBe("v2");
  });
});

describe("fill state to template inputs", () => {
  it("omits text left at its default or cleared, and empty slots", () => {
    const description = describeById("product-launch");
    let state = initialFillState(description, [{ id: "v1", type: "video" }]);
    state = setText(state, "headline", "Ship faster");
    state = setText(state, "kicker", "  ");
    const inputs = buildTemplateInputs(description, state);
    expect(inputs.texts).toEqual({ headline: "Ship faster" });
    expect(inputs.slots).toEqual({ "rec-1": "v1" });
  });
  it("lists required slots left empty, and not optional ones", () => {
    const description = describeById("product-launch");
    const state = initialFillState(description, []);
    const empty = emptyRequiredSlots(description, state);
    expect(empty).toHaveLength(3);
    expect(empty.join(" ")).not.toMatch(/Logo|Music/);
  });
  it("sizes repeat groups within min and max and builds one input per item", () => {
    const description = describeById("listicle");
    const group = need(description.repeat[0]);
    let state = initialFillState(description, []);
    expect(state.repeat[group.id]?.count).toBe(group.min);
    state = setRepeatCount(state, group, 99);
    expect(state.repeat[group.id]?.count).toBe(group.max);
    state = setRepeatCount(state, group, 0);
    expect(state.repeat[group.id]?.count).toBe(group.min);
    state = setRepeatItem(state, group.id, 1, { textId: "title", value: "Light it well" });
    state = setRepeatItem(state, group.id, 1, { slotId: "clip", assetId: "v9" });
    const items = buildTemplateInputs(description, state).repeat?.[group.id] ?? [];
    expect(items).toHaveLength(group.min);
    expect(items[1]).toEqual({ slots: { clip: "v9" }, texts: { title: "Light it well" } });
    expect(items[0]).toEqual({ slots: {}, texts: {} });
    expect(repeatTextPlaceholder("Tip {n} of {count}", 1, 3)).toBe("Tip 2 of 3");
  });
});

describe("inspiration", () => {
  it("lists only text links to x.com posts of the matching handle, plus the collection", () => {
    for (const entry of INSPIRATION.entries) {
      const url = new URL(entry.href);
      expect(url.protocol).toBe("https:");
      expect(url.hostname).toBe("x.com");
      expect(url.pathname.toLowerCase().startsWith(`/${entry.handle.slice(1).toLowerCase()}/status/`)).toBe(true);
    }
    expect(INSPIRATION.collection.href).toBe("https://notes.apoorv.xyz/launch-videos");
    expect(INSPIRATION.note).toBe("Our templates are original; these are posts that inspired them.");
  });
});
