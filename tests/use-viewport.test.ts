import { describe, expect, it, vi } from "vitest";
import {
  COMPACT_QUERY, PHONE_QUERY, readViewport, subscribeViewport, type MediaQueryListLike, type MediaQuerySource,
} from "#/ui/editor/use-viewport";

/** A fake window whose matches follow `width`, with listeners fired by `resize`. */
function fakeWindow(initialWidth: number): MediaQuerySource & { resize(width: number): void; listenerCount(): number } {
  let width = initialWidth;
  const listeners = new Set<() => void>();
  const maxWidthOf = (query: string): number => Number(/max-width: ([\d.]+)px/.exec(query)?.[1]);
  return {
    matchMedia(query: string): MediaQueryListLike {
      return {
        get matches() { return width <= maxWidthOf(query); },
        addEventListener: (_type, listener) => void listeners.add(listener),
        removeEventListener: (_type, listener) => void listeners.delete(listener),
      };
    },
    resize(next) {
      width = next;
      for (const listener of [...listeners]) listener();
    },
    listenerCount: () => listeners.size,
  };
}

describe("readViewport", () => {
  it.each([
    [1440, "desktop"], [900, "desktop"], [899, "compact"], [768, "compact"], [600, "compact"], [599, "phone"], [390, "phone"], [360, "phone"],
  ] as const)("classifies %ipx as %s", (width, tier) => {
    const info = readViewport(fakeWindow(width));
    expect(info.tier).toBe(tier);
    expect(info.compact).toBe(tier !== "desktop");
    expect(info.phone).toBe(tier === "phone");
  });

  it("returns a stable object per tier so useSyncExternalStore does not loop", () => {
    expect(readViewport(fakeWindow(500))).toBe(readViewport(fakeWindow(320)));
  });

  it("falls back to desktop without matchMedia", () => {
    expect(readViewport(undefined).tier).toBe("desktop");
    expect(readViewport({}).tier).toBe("desktop");
  });

  it("uses the same 900 px edge as the desktop layout", () => {
    expect(COMPACT_QUERY).toContain("899.98px");
    expect(PHONE_QUERY).toContain("599.98px");
  });
});

describe("subscribeViewport", () => {
  it("notifies on breakpoint changes and stops after unsubscribe", () => {
    const win = fakeWindow(1200);
    const onChange = vi.fn();
    const stop = subscribeViewport(win, onChange);
    win.resize(700);
    expect(onChange).toHaveBeenCalled();
    expect(readViewport(win).tier).toBe("compact");
    stop();
    expect(win.listenerCount()).toBe(0);
    onChange.mockClear();
    win.resize(1200);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("is a no-op without matchMedia", () => {
    expect(() => subscribeViewport(undefined, vi.fn())()).not.toThrow();
  });
});
