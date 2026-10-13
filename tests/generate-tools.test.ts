import { describe, expect, it } from "vitest";
import {
  MAX_GENERATIONS_PER_RUN, callTool, createGenerateTools, isSingleTargetedEdit, planScopeViolation,
  type AgentToolRegistry, type GenerateDeps, type Plan,
} from "#/engine/agent";
import { makeEditor } from "./helpers";

function setup(overrides: Partial<GenerateDeps> = {}) {
  const { editor } = makeEditor();
  const generated: unknown[] = [];
  const deps: GenerateDeps = {
    prepare: ({ kind }) => ({ modelId: `${kind}-m`, modelName: `${kind} model`, costText: "About $0.04" }),
    generate: async (input) => { generated.push(input); return { assetId: "gen-1", name: "generated-x.png", type: "image", chargeText: "Charged about $0.04." }; },
    ...overrides,
  };
  const tools = new Map(createGenerateTools(deps).map((t) => [t.name, t])) as AgentToolRegistry;
  const ctx = { editor, nowMs: () => 0 };
  return { tools, generated, call: (args: unknown) => callTool({ tools, name: "generate_media", args, ctx }) };
}

const plan = (tools: string[]): Plan => ({ summary: "s", steps: [{ intent: "make an image", tools, targets: [], check: "asset exists" }] });

describe("generate_media", () => {
  it("is a costly, non-read-only tool that can never be the unplanned single edit", () => {
    const tool = setup().tools.get("generate_media")!;
    expect(tool.readOnly).toBe(false);
    expect(tool.destructive).toBe(true);
    expect(isSingleTargetedEdit(tool, { kind: "image", prompt: "a cat" })).toBe(false);
    expect(tool.description).toMatch(/COSTS REAL MONEY/);
  });

  it("only runs after a plan that lists it", () => {
    const tool = setup().tools.get("generate_media")!;
    const args = { kind: "image", prompt: "a cat" };
    expect(planScopeViolation({ plan: plan(["insert_media"]), tool, args, existingIds: new Set() })).toMatch(/not in the approved plan/);
    expect(planScopeViolation({ plan: plan(["generate_media"]), tool, args, existingIds: new Set() })).toBeNull();
  });

  it("generates and tells the model the asset id, model and cost", async () => {
    const { call, generated } = setup();
    const result = await call({ kind: "image", prompt: "a cat" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.summary).toContain("gen-1");
    expect(result.summary).toContain("image model");
    expect(result.summary).toContain("Charged about $0.04.");
    expect(result.summary).toContain("insert_media");
    expect(generated).toEqual([{ kind: "image", prompt: "a cat" }]);
  });

  it("validates input before spending anything", async () => {
    const { call, generated } = setup();
    expect((await call({ kind: "gif", prompt: "x" })).ok).toBe(false);
    expect((await call({ kind: "image" })).ok).toBe(false);
    expect(generated).toHaveLength(0);
  });

  it("refuses an over-allowance estimate without generating", async () => {
    const { call, generated } = setup({ prepare: () => ({ modelId: "m", modelName: "M", costText: "About $5.00", refusal: "Estimated $5.00 is above the $1.00 allowance." }) });
    const result = await call({ kind: "video", prompt: "x" });
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining("above the $1.00") });
    expect(generated).toHaveLength(0);
  });

  it("caps how often one run may spend, but a failed attempt does not use up the allowance", async () => {
    const { call } = setup();
    for (let i = 0; i < MAX_GENERATIONS_PER_RUN; i++) expect((await call({ kind: "image", prompt: `p${i}` })).ok).toBe(true);
    expect(await call({ kind: "image", prompt: "one more" })).toMatchObject({ ok: false, error: expect.stringContaining("Already generated") });

    const flaky = setup({ generate: async () => { throw new Error("Not enough Surplus credit (402)."); } });
    for (let i = 0; i < MAX_GENERATIONS_PER_RUN + 1; i++) {
      expect(await flaky.call({ kind: "image", prompt: "x" })).toMatchObject({ ok: false, error: expect.stringContaining("credit"), hint: expect.stringContaining("Do not retry") });
    }
  });

  it("passes model errors through unknown-model hints", async () => {
    const { call } = setup({ prepare: () => ({ error: "No image model \"zzz\" in the catalog.", hint: "Known image models: a, b." }) });
    expect(await call({ kind: "image", prompt: "x", model: "zzz" })).toMatchObject({ ok: false, hint: "Known image models: a, b." });
  });
});
