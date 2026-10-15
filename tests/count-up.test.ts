import { describe, expect, it } from "vitest";
import { insertElement, setTextAnimationCommand, updateElements } from "#/engine/commands";
import { PARAM, type TextElement } from "#/engine/model";
import { formatCount, inferCount, type CountSpec } from "#/engine/render";
import { allElements, resolveElementParams } from "#/engine/timeline";
import { displayedContent } from "#/render/text";
import { setupAgent } from "./agent-harness";
import { makeEditor, sec, text } from "./helpers";

const spec = (extra: Partial<CountSpec> = {}): CountSpec => ({ format: "plain", decimals: 0, prefix: "", suffix: "", ...extra });

describe("formatCount", () => {
  it("formats plain, grouped, compact and percent numbers", () => {
    expect(formatCount({ value: 1234.56, ...spec() })).toBe("1235");
    expect(formatCount({ value: 1234567.891, ...spec({ format: "thousands", decimals: 2 }) })).toBe("1,234,567.89");
    expect(formatCount({ value: 999, ...spec({ format: "compact" }) })).toBe("999");
    expect(formatCount({ value: 12_400, ...spec({ format: "compact", decimals: 1 }) })).toBe("12.4K");
    expect(formatCount({ value: 3_500_000, ...spec({ format: "compact", decimals: 1 }) })).toBe("3.5M");
    expect(formatCount({ value: 2e9, ...spec({ format: "compact" }) })).toBe("2B");
    expect(formatCount({ value: 42.5, ...spec({ format: "percent", decimals: 1 }) })).toBe("42.5%");
  });
  it("wraps prefix and suffix around the number and keeps the sign next to the digits", () => {
    expect(formatCount({ value: -1500, ...spec({ format: "thousands", prefix: "$", suffix: "+" }) })).toBe("$-1,500+");
    expect(formatCount({ value: 5, ...spec({ prefix: "#" }) })).toBe("#5");
  });
  it("never prints negative zero or a sign for a value that rounds to zero, and survives bad input", () => {
    expect(formatCount({ value: -0.0004, ...spec({ decimals: 2 }) })).toBe("0.00");
    expect(formatCount({ value: -0, ...spec() })).toBe("0");
    expect(formatCount({ value: Number.NaN, ...spec() })).toBe("0");
    expect(formatCount({ value: Number.POSITIVE_INFINITY, ...spec() })).toBe("0");
    expect(formatCount({ value: 1.23456789, ...spec({ decimals: 40 }) })).toBe("1.234568");
  });
  it("is steady while counting: the digits never get longer before the end", () => {
    const widths = Array.from({ length: 21 }, (_, i) => formatCount({ value: (12_400 * i) / 20, ...spec({ format: "thousands" }) }).length);
    for (let i = 1; i < widths.length; i++) expect(widths[i]).toBeGreaterThanOrEqual(widths[i - 1] as number);
  });
});

describe("inferCount", () => {
  it("reads the number, affixes, grouping and decimals out of text", () => {
    expect(inferCount("$12,400+")).toEqual({ value: 12400, format: "thousands", decimals: 0, prefix: "$", suffix: "+" });
    expect(inferCount("98.6%")).toEqual({ value: 98.6, format: "percent", decimals: 1, prefix: "", suffix: "" });
    expect(inferCount("1.2M users")).toEqual({ value: 1_200_000, format: "compact", decimals: 1, prefix: "", suffix: " users" });
    expect(inferCount("42")).toEqual({ value: 42, format: "plain", decimals: 0, prefix: "", suffix: "" });
    expect(inferCount("  -7 °C ")).toEqual({ value: -7, format: "plain", decimals: 0, prefix: "", suffix: " °C" });
  });
  it("says nothing when there is no number to count to", () => {
    expect(inferCount("Hello")).toBeNull();
    expect(inferCount("")).toBeNull();
    expect(inferCount("-")).toBeNull();
  });
  it("round-trips: the formatted result reads back as the same count", () => {
    for (const content of ["$12,400+", "98.6%", "1.2M", "42", "3,000"]) {
      const parsed = inferCount(content)!;
      expect(formatCount(parsed)).toBe(content);
    }
  });
});

describe("displayedContent", () => {
  it("shows the content until counting is switched on", () => {
    const base = { [PARAM.content]: "Hello", [PARAM.countValue]: 7 };
    expect(displayedContent(base)).toBe("Hello");
    expect(displayedContent({ ...base, [PARAM.countEnabled]: true })).toBe("7");
    expect(displayedContent({ ...base, [PARAM.countEnabled]: true, [PARAM.countFormat]: "bogus", [PARAM.countPrefix]: "~" })).toBe("~7");
  });
});

describe("the count-up animation", () => {
  const setup = (content: string, seconds = 6) => {
    const { editor } = makeEditor();
    const element: TextElement = { ...text("t", 0, seconds), params: { ...text("t", 0).params, [PARAM.content]: content } };
    editor.execute(insertElement({ element, placement: { mode: "newTrack", index: 0, trackId: "txt" } }));
    return { editor, ref: { trackId: "txt", elementId: "t" } };
  };
  const get = (editor: ReturnType<typeof setup>["editor"]): TextElement => allElements(editor.tracks()).find((l) => l.element.id === "t")!.element as TextElement;
  const shown = (editor: ReturnType<typeof setup>["editor"], seconds: number): string => displayedContent(resolveElementParams(get(editor), sec(seconds)));

  it("counts from zero to the number in the text with its formatting, easing out", () => {
    const { editor, ref } = setup("$12,400+");
    editor.execute(setTextAnimationCommand({ ref, in: { preset: "count-up", duration: sec(2) as never } }));
    expect(get(editor).params).toMatchObject({ countEnabled: true, countValue: 12400, countFormat: "thousands", countPrefix: "$", countSuffix: "+" });
    expect(shown(editor, 0)).toBe("$0+");
    expect(shown(editor, 2)).toBe("$12,400+");
    expect(shown(editor, 5)).toBe("$12,400+");
    const early = resolveElementParams(get(editor), sec(0.4))[PARAM.countValue] as number;
    const late = resolveElementParams(get(editor), sec(1.6))[PARAM.countValue] as number;
    expect(early).toBeGreaterThan(12400 * 0.3);
    expect(12400 - late).toBeLessThan(12400 * 0.05);
    const values = Array.from({ length: 41 }, (_, i) => resolveElementParams(get(editor), sec(i * 0.05))[PARAM.countValue] as number);
    for (let i = 1; i < values.length; i++) expect(values[i]).toBeGreaterThanOrEqual(values[i - 1] as number);
  });
  it("counts back down on the way out, and a second apply keeps the target", () => {
    const { editor, ref } = setup("500");
    editor.execute(setTextAnimationCommand({ ref, in: { preset: "count-up", duration: sec(1) as never } }));
    editor.execute(setTextAnimationCommand({ ref, out: { preset: "count-up", duration: sec(1) as never } }));
    expect(shown(editor, 3)).toBe("500");
    expect(shown(editor, 6)).toBe("0");
    expect(get(editor).params[PARAM.countValue]).toBe(500);
  });
  it("refuses text with no number and leaves the clip alone; undo removes everything", () => {
    const { editor, ref } = setup("Hello");
    const before = JSON.stringify(get(editor));
    expect(() => editor.execute(setTextAnimationCommand({ ref, in: { preset: "count-up", duration: sec(1) as never } }))).toThrow(/needs a number/);
    expect(JSON.stringify(get(editor))).toBe(before);
    const other = setup("77");
    other.editor.execute(setTextAnimationCommand({ ref: other.ref, in: { preset: "count-up", duration: sec(1) as never } }));
    other.editor.undo();
    expect(get(other.editor).params[PARAM.countEnabled]).toBeUndefined();
    expect(get(other.editor).animations).toBeUndefined();
  });
  it("can be driven by hand: keyframes on the number work like any parameter", () => {
    const { editor, ref } = setup("x");
    editor.execute(updateElements([{ ref, patch: { params: { [PARAM.countEnabled]: true, [PARAM.countValue]: 10, [PARAM.countFormat]: "plain" } } }]));
    expect(shown(editor, 1)).toBe("10");
  });
});

describe("agent access", () => {
  it("set_text_animation accepts count-up and reports a clear error for text without digits", async () => {
    const h = setupAgent();
    const { elementId } = await h.data<{ elementId: string }>("insert_text", { text: "10,000 users", start: 0, duration: 5 });
    await h.data("set_text_animation", { elementIds: [elementId], in: { preset: "count-up", duration: 1.5 } });
    const params = allElements(h.editor.tracks()).find((l) => l.element.id === elementId)!.element.params;
    expect(params).toMatchObject({ countEnabled: true, countValue: 10000, countSuffix: " users" });
    const word = await h.data<{ elementId: string }>("insert_text", { text: "none", start: 6, duration: 3 });
    expect((await h.failure("set_text_animation", { elementIds: [word.elementId], in: { preset: "count-up" } })).error).toContain("number");
  });
});
