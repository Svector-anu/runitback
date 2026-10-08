import { describe, expect, it } from "vitest";
import { didYouMean, validateInput, type JsonSchema } from "#/engine/agent";

const schema: JsonSchema = {
  type: "object",
  properties: {
    elementId: { type: "string" },
    start: { type: "number", minimum: 0, maximum: 100 },
    count: { type: "integer" },
    mode: { type: "string", enum: ["left", "right"] },
    flag: { type: "boolean" },
    ids: { type: "array", items: { type: "string" } },
    free: { type: "object" },
    either: { oneOf: [{ type: "string" }, { type: "number" }] },
  },
  required: ["elementId"],
};

describe("validateInput", () => {
  it("accepts valid input and returns it", () => {
    const out = validateInput(schema, { elementId: "a", start: 1.5, ids: ["x"], free: { anything: [1] }, either: 3 });
    expect(out).toEqual({ ok: true, value: { elementId: "a", start: 1.5, ids: ["x"], free: { anything: [1] }, either: 3 } });
  });
  it("treats missing input as an empty object", () => {
    const out = validateInput({ type: "object", properties: {} }, undefined);
    expect(out).toEqual({ ok: true, value: {} });
  });
  it("rejects missing required fields and suggests the right spelling", () => {
    const out = validateInput(schema, { element_id: "a" });
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.error).toContain('Missing required field "elementId"');
    }
  });
  it("rejects unknown keys with a did-you-mean hint and the valid list", () => {
    const out = validateInput(schema, { elementId: "a", strat: 1 });
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.error).toContain('Unknown field "strat"');
      expect(out.hint).toContain('Did you mean "start"');
      expect(out.hint).toContain("Valid fields");
    }
  });
  it("checks types, integers, enums and ranges", () => {
    const bad = (input: unknown) => validateInput(schema, { elementId: "a", ...(input as object) });
    expect(bad({ start: "1" }).ok).toBe(false);
    expect(bad({ start: Number.NaN }).ok).toBe(false);
    expect(bad({ start: -1 }).ok).toBe(false);
    expect(bad({ start: 101 }).ok).toBe(false);
    expect(bad({ count: 1.5 }).ok).toBe(false);
    expect(bad({ flag: "yes" }).ok).toBe(false);
    expect(bad({ ids: ["a", 2] }).ok).toBe(false);
    const enumResult = bad({ mode: "lefft" });
    expect(enumResult.ok).toBe(false);
    if (!enumResult.ok) expect(enumResult.hint).toContain('Did you mean "left"');
    expect(bad({ either: true }).ok).toBe(false);
  });
  it("names the nested path of an array error", () => {
    const out = validateInput(schema, { elementId: "a", ids: ["a", 2] });
    if (out.ok) throw new Error("expected failure");
    expect(out.error).toContain("ids[1]");
  });
  it("didYouMean only suggests close matches", () => {
    expect(didYouMean("opcity", ["opacity", "volume"])).toBe("opacity");
    expect(didYouMean("zzzzzz", ["opacity", "volume"])).toBeUndefined();
  });
});
