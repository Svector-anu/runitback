import { describe, expect, it } from "vitest";
import { MAX_CUE_SECONDS, parseAss, parseSrt, parseSubtitleFile, stripOverrideBlocks } from "#/engine/captions/parse";

const assFile = (text: string, start = "0:00:01.00", end = "0:00:02.00"): string =>
  `[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,${start},${end},Default,,0,0,0,,${text}\n`;

describe("P1-10 ASS override stripping", () => {
  it("is linear on a hostile line of unmatched braces", () => {
    const hostile = "{".repeat(200_000);
    const started = performance.now();
    const result = parseAss(assFile(hostile));
    expect(performance.now() - started).toBeLessThan(100);
    expect(result.cues).toHaveLength(1);
  });

  it("matches the old regex semantics", () => {
    for (const input of ["a{b}c", "a{b{c}d", "{x}{y}z", "no braces", "a}b{c", "{", "}", "a{b}c{d"]) {
      expect(stripOverrideBlocks(input)).toBe(input.replace(/\{[^}]*\}/g, ""));
    }
  });
});

describe("P1-11 unbounded timestamps", () => {
  it("skips ASS cues past the 24h cap and keeps normal ones", () => {
    const result = parseAss(assFile("late", "99999999999:00:00.00", "99999999999:00:01.00"));
    expect(result.cues).toEqual([]);
    expect(result.skipped).toBe(1);
    expect(parseAss(assFile("ok")).cues).toHaveLength(1);
    expect(MAX_CUE_SECONDS).toBe(86_400);
  });

  it("skips SRT cues past 24h", () => {
    const result = parseSrt("1\n99:00:00,000 --> 99:00:01,000\nlate\n");
    expect(result.cues).toEqual([]);
    expect(result.skipped).toBe(1);
  });

  it("rejects oversized subtitle files before parsing", () => {
    expect(() => parseSubtitleFile({ name: "x.ass", text: "a".repeat(5_000_001) })).toThrow(/too large/);
  });
});
