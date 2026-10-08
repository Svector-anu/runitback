import { describe, expect, it } from "vitest";
import { shouldYieldToFocusedControl } from "#/app/shortcut-guard";

/** A target whose `closest` answers true for the listed tags / roles / attributes. */
const target = (...matches: string[]): { closest: (selector: string) => unknown } => ({
  closest: (selector) => (matches.some((m) => selector.split(",").map((p) => p.trim()).includes(m)) ? {} : null),
});
const key = (k: string, mods: Partial<{ ctrlKey: boolean; metaKey: boolean; altKey: boolean }> = {}) =>
  ({ key: k, ctrlKey: false, metaKey: false, altKey: false, ...mods });

describe("P1-8 Enter/Space on focused controls", () => {
  it("yields Enter and Space to buttons, links, tabs and menu items", () => {
    for (const el of ["button", "a[href]", "[role='tab']", "[role='menuitem']", "[role='button']"]) {
      expect(shouldYieldToFocusedControl(key("Enter"), target(el))).toBe(true);
      expect(shouldYieldToFocusedControl(key(" "), target(el))).toBe(true);
    }
  });

  it("keeps global shortcuts for non-activation keys, modified keys and plain targets", () => {
    expect(shouldYieldToFocusedControl(key("l"), target("button"))).toBe(false);
    expect(shouldYieldToFocusedControl(key("Enter", { metaKey: true }), target("button"))).toBe(false);
    expect(shouldYieldToFocusedControl(key("Enter"), target())).toBe(false);
    expect(shouldYieldToFocusedControl(key("Enter"), null)).toBe(false);
  });

  it("lets timeline clips and the playhead keep transport shortcuts", () => {
    expect(shouldYieldToFocusedControl(key(" "), target("button", "[data-clip-id]"))).toBe(false);
  });
});
