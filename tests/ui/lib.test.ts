import { describe, expect, it } from "vitest";
import { evaluateExpression, pixelsPerUnit } from "#/ui/lib/expression";
import { clampPair } from "#/ui/primitives/split";

describe("evaluateExpression", () => {
  it.each([
    ["1+2*3", 7], ["(1+2)*3", 9], ["-4 + 10", 6], ["10/4", 2.5], ["1,5*2", 3], [" 2 * (3 + 4) - 1 ", 13], ["1e2", 100], [".5+.25", 0.75],
  ])("%s = %s", (input, expected) => expect(evaluateExpression(input)).toBe(expected));
  it.each(["", "abc", "1+", "(1", "1)", "2**3", "alert(1)", "1/0", "--"])("rejects %j", (input) => expect(evaluateExpression(input)).toBeNull());
});

describe("pixelsPerUnit", () => {
  const ranges = [{ upTo: 1, pxPerUnit: 160 }, { upTo: 5, pxPerUnit: 48 }];
  it("uses finer control at low values", () => {
    expect(pixelsPerUnit(0.5, ranges, 10)).toBe(160);
    expect(pixelsPerUnit(3, ranges, 10)).toBe(48);
    expect(pixelsPerUnit(9, ranges, 10)).toBe(10);
  });
});

describe("clampPair", () => {
  const constraints = [{ min: 15, max: 40 }, { min: 30 }, { min: 15, max: 40 }];
  it("moves the divider between two panes and keeps the sum", () => {
    const next = clampPair({ sizes: [25, 50, 25], index: 0, delta: 5, constraints });
    expect(next).toEqual([30, 45, 25]);
    expect(next.reduce((a, b) => a + b, 0)).toBe(100);
  });
  it("respects min and max of both neighbours", () => {
    expect(clampPair({ sizes: [25, 50, 25], index: 0, delta: 100, constraints })[0]).toBe(40);
    expect(clampPair({ sizes: [25, 50, 25], index: 0, delta: -100, constraints })[0]).toBe(15);
    expect(clampPair({ sizes: [25, 50, 25], index: 1, delta: 100, constraints })[2]).toBe(15);
  });
});
