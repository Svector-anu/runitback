import { describe, expect, it } from "vitest";
import { callTool, createAgentTools, type AgentToolRegistry } from "#/engine/agent";
import { createUnderstandTools } from "#/engine/agent/tools-understand";
import { NO_STORED_STAGES, type StoredStages, type UnderstandRunSummary, type UnderstandStartResult } from "#/engine/understand";
import { ASSETS } from "./agent-harness";
import { makeEditor } from "./helpers";

function setup(options: { stored?: Record<string, Partial<StoredStages>>; start?: (assetId: string) => Promise<UnderstandStartResult> } = {}) {
  const { editor } = makeEditor({ assets: ASSETS });
  const tools = new Map(createUnderstandTools({
    status: { stored: async (asset) => ({ ...NO_STORED_STAGES, ...options.stored?.[asset.id] }) },
    ...(options.start ? { start: options.start } : {}),
  }).map((t) => [t.name, t])) as AgentToolRegistry;
  const ctx = { editor, nowMs: () => 0 };
  return { call: (name: string, args: unknown = {}) => callTool({ tools, name, args, ctx }), tools };
}

const summary = (cancelled = false): UnderstandRunSummary => ({
  assetId: "a1", cancelled, errors: {},
  outcomes: { analysis: "done", transcript: "done", visual: "done", faces: "done" },
});

describe("get_understanding_status", () => {
  it("reports indexed and missing stages per asset, honouring what does not apply", async () => {
    const { call } = setup({ stored: { a1: { analysis: true, visual: true } } });
    const result = await call("get_understanding_status", { assetId: "a1" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const [asset] = (result.data as { assets: Array<{ state: string; indexed: string[]; missing: string[] }> }).assets;
    expect(asset).toMatchObject({ state: "partial", indexed: ["analysis", "visual"], missing: ["transcript", "faces"] });
  });

  it("lists every asset when none is given, and marks images not applicable", async () => {
    const { call } = setup();
    const result = await call("get_understanding_status");
    if (!result.ok) throw new Error(result.error);
    const assets = (result.data as { assets: Array<{ assetId: string; state: string }> }).assets;
    expect(assets).toHaveLength(ASSETS.length);
    expect(assets.find((a) => a.assetId === "photo")?.state).toBe("not-applicable");
  });

  it("explains an unknown asset id", async () => {
    const result = await setup().call("get_understanding_status", { assetId: "nope" });
    expect(result.ok).toBe(false);
  });

  it("omits understand_media when no start function is wired", () => {
    expect([...setup().tools.keys()]).toEqual(["get_understanding_status"]);
  });
});

describe("understand_media", () => {
  it("returns a consent hint for the agent when the download is unapproved", async () => {
    const { call } = setup({ start: async () => ({ status: "needs-consent", downloads: [{ stage: "transcript", model: "whisper", approxMegabytes: 50 }] }) });
    const result = await call("understand_media", { assetId: "a1" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("press Understand");
    expect(result.error).toContain("whisper");
    expect(result.hint).toContain("user confirms");
  });

  it("waits for the run and reports the resulting status", async () => {
    let stored: Partial<StoredStages> = {};
    const { editor } = makeEditor({ assets: ASSETS });
    const tools = new Map(createUnderstandTools({
      status: { stored: async () => ({ ...NO_STORED_STAGES, ...stored }) },
      start: async () => ({ status: "started", completion: Promise.resolve().then(() => { stored = { analysis: true, transcript: true, visual: true, faces: true }; return summary(); }) }),
    }).map((t) => [t.name, t])) as AgentToolRegistry;
    const result = await callTool({ tools, name: "understand_media", args: { assetId: "a1" }, ctx: { editor, nowMs: () => 0 } });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.summary).toContain("Understood");
  });

  it("returns immediately with wait:false", async () => {
    const { call } = setup({ start: async () => ({ status: "started", completion: new Promise<UnderstandRunSummary>(() => undefined) }) });
    const result = await call("understand_media", { assetId: "a1", wait: false });
    expect(result.ok).toBe(true);
  });

  it("refuses images and unknown assets", async () => {
    const { call } = setup({ start: async () => ({ status: "nothing-to-do" }) });
    expect((await call("understand_media", { assetId: "photo" })).ok).toBe(false);
    expect((await call("understand_media", { assetId: "zzz" })).ok).toBe(false);
  });

  it("is not part of the default tool set (wired by the app)", () => {
    expect(createAgentTools().has("understand_media")).toBe(false);
  });
});
