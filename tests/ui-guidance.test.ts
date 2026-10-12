import { describe, expect, it } from "vitest";
import { HINTS_SEEN_PREF, PrefsStore, TOUR_SEEN_PREF, type PrefsBackend } from "../src/platform/prefs";
import { HintStore } from "../src/ui/lib/hints";
import { TOUR_STEPS, TourStore, isAutomated } from "../src/ui/lib/tour";
import { chooseSide, placeCard } from "../src/ui/tour/placement";

function memoryPrefs(): { prefs: PrefsStore; raw: Map<string, string> } {
  const raw = new Map<string, string>();
  const backend: PrefsBackend = { getItem: (k) => raw.get(k) ?? null, setItem: (k, v) => void raw.set(k, v) };
  return { prefs: new PrefsStore(backend), raw };
}

describe("HintStore", () => {
  it("shows a hint until it is marked seen, and persists that", () => {
    const { prefs, raw } = memoryPrefs();
    const store = new HintStore(prefs);
    expect(store.isSeen("first-clip")).toBe(false);
    store.markSeen("first-clip");
    expect(store.isSeen("first-clip")).toBe(true);
    expect(raw.get(`runitback:${HINTS_SEEN_PREF}`)).toBe('["first-clip"]');
    expect(new HintStore(prefs).isSeen("first-clip")).toBe(true);
  });

  it("notifies subscribers once per change and not for repeats", () => {
    const store = new HintStore(memoryPrefs().prefs);
    let calls = 0;
    store.subscribe(() => { calls++; });
    store.markSeen("plan-card");
    store.markSeen("plan-card");
    expect(calls).toBe(1);
    store.reset();
    expect(calls).toBe(2);
    expect(store.isSeen("plan-card")).toBe(false);
  });

  it("falls back to nothing seen when the stored value is corrupt", () => {
    const { prefs, raw } = memoryPrefs();
    raw.set(`runitback:${HINTS_SEEN_PREF}`, "{\"oops\":1}");
    expect(new HintStore(prefs).isSeen("agent-key")).toBe(false);
  });
});

describe("TourStore", () => {
  it("auto-starts once for a first-time person and never again after closing", () => {
    const { prefs, raw } = memoryPrefs();
    const tour = new TourStore(prefs);
    expect(tour.autoStart(false)).toBe(true);
    expect(tour.getSnapshot()).toEqual({ open: true, step: 0 });
    tour.close();
    expect(raw.get(`runitback:${TOUR_SEEN_PREF}`)).toBe("true");
    expect(new TourStore(prefs).autoStart(false)).toBe(false);
  });

  it("does not auto-start under automation, but Help can still start it", () => {
    const tour = new TourStore(memoryPrefs().prefs);
    expect(tour.autoStart(true)).toBe(false);
    tour.start();
    expect(tour.getSnapshot().open).toBe(true);
  });

  it("walks every step, goes back, and finishing closes and records it", () => {
    const { prefs } = memoryPrefs();
    const tour = new TourStore(prefs);
    tour.start();
    for (let i = 1; i < TOUR_STEPS.length; i++) tour.next();
    expect(tour.getSnapshot().step).toBe(TOUR_STEPS.length - 1);
    tour.back();
    expect(tour.getSnapshot().step).toBe(TOUR_STEPS.length - 2);
    tour.next();
    tour.next();
    expect(tour.getSnapshot().open).toBe(false);
    expect(tour.hasBeenSeen()).toBe(true);
  });

  it("covers the five documented stops in order", () => {
    expect(TOUR_STEPS.map((s) => s.target)).toEqual(["import", "understand", "agent", "timeline", "export"]);
  });
});

describe("isAutomated", () => {
  it("is true for webdriver unless ?tour is in the URL", () => {
    expect(isAutomated({ webdriver: true }, "")).toBe(true);
    expect(isAutomated({ webdriver: true }, "?tour=1")).toBe(false);
    expect(isAutomated({ webdriver: false }, "")).toBe(false);
  });
});

describe("tour placement", () => {
  const viewport = { width: 1000, height: 700 };
  const card = { left: 0, top: 0, width: 300, height: 150 };

  it("keeps the preferred side when it fits and flips when it does not", () => {
    const left = { left: 20, top: 100, width: 100, height: 30 };
    expect(chooseSide({ target: left, card, viewport, preferred: "right" })).toBe("right");
    const edge = { left: 880, top: 100, width: 100, height: 30 };
    expect(chooseSide({ target: edge, card, viewport, preferred: "right" })).toBe("left");
  });

  it("never places the card outside the viewport", () => {
    const target = { left: 900, top: 10, width: 90, height: 30 };
    const { left, top } = placeCard({ target, card, viewport, side: "below" });
    expect(left + card.width).toBeLessThanOrEqual(viewport.width);
    expect(top).toBeGreaterThanOrEqual(0);
  });
});
