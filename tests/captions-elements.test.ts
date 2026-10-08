import { describe, expect, it } from "vitest";
import { buildCaptionElement, wrapText } from "#/render/caption-elements";
import { mediaTime } from "#/engine/time";
import { sec } from "./helpers";

const measure = (line: string): number => line.length * 10;
const canvas = { width: 1000, height: 900 };

describe("wrapText", () => {
  it("wraps greedily at the width and keeps explicit newlines", () => {
    expect(wrapText({ text: "aaa bbb ccc ddd", maxWidth: 80, measure })).toBe("aaa bbb\nccc ddd");
    expect(wrapText({ text: "one\ntwo three", maxWidth: 1000, measure })).toBe("one\ntwo three");
    expect(wrapText({ text: "superlongword", maxWidth: 20, measure })).toBe("superlongword");
  });
});

describe("buildCaptionElement", () => {
  const cue = { text: "Hello there", startTime: sec(2), duration: sec(1.5) };
  it("styles default captions bold white at size 5 and anchors them above the bottom margin", () => {
    const el = buildCaptionElement({ cue, index: 0, id: "c", canvas, measure });
    expect(el).toMatchObject({ name: "Caption 1", startTime: sec(2), duration: sec(1.5) });
    expect(el.params).toMatchObject({ fontSize: 5, fontWeight: "bold", color: "#ffffff", textAlign: "center", content: "Hello there" });
    expect(Number(el.params["transform.positionY"])).toBeGreaterThan(0);
    expect(Number(el.params["transform.positionY"])).toBeLessThan(canvas.height / 2);
  });
  it("converts ASS style: size ratio, colour, background and vertical alignment", () => {
    const el = buildCaptionElement({
      cue: { ...cue, style: { fontSizeRatio: 0.05, color: "#0080ff", bold: false, vertical: "top", marginVerticalRatio: 0.1, backgroundColor: "#00000080" } },
      index: 3, id: "c", canvas, measure,
    });
    expect(el.name).toBe("Caption 4");
    expect(el.params).toMatchObject({ fontSize: 4.5, color: "#0080ff", fontWeight: "normal", "background.enabled": true });
    expect(Number(el.params["transform.positionY"])).toBeLessThan(0);
  });
  it("long captions wrap inside 80% of the canvas width", () => {
    const text = Array.from({ length: 30 }, () => "word").join(" ");
    const el = buildCaptionElement({ cue: { ...cue, text }, index: 0, id: "c", canvas, measure });
    const lines = String(el.params.content).split("\n");
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) expect(measure(line)).toBeLessThanOrEqual(800 + 40);
  });
  it("falls back to a default duration for empty cues", () => {
    const el = buildCaptionElement({ cue: { ...cue, duration: mediaTime(0) }, index: 0, id: "c", canvas, measure });
    expect(el.duration).toBeGreaterThan(0);
  });
});
