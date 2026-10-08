import { describe, expect, it } from "vitest";
import { callTool, createVisualTools } from "#/engine/agent";
import { createMemoryVisualStore, type VisualIndexer } from "#/engine/visual";
import { PrefsStore } from "#/platform/prefs";
import { ModelConsent } from "#/app/model-consent";
import { VISUAL_CONSENT_PREF, VisualConsentRequiredError, VisualService } from "#/app/visual-service";
import { A1_CUTS, A1_FRAMES, fakeSearcher, makeEmbeddings } from "./visual-harness";
import { makeEditor } from "./helpers";
import { ASSETS } from "./agent-harness";

const memoryPrefs = (): PrefsStore => {
  const data = new Map<string, string>();
  return new PrefsStore({ getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) });
};

function setup(options: { cached?: boolean } = {}) {
  const runs: string[] = [];
  const store = createMemoryVisualStore();
  const prefs = memoryPrefs();
  const searcher = fakeSearcher("m/clip");
  const indexer: VisualIndexer = {
    async index({ assetId, onProgress }) {
      runs.push(assetId);
      onProgress?.(0.5);
      return makeEmbeddings({ assetId, model: "m/clip", frames: A1_FRAMES, cuts: A1_CUTS });
    },
  };
  const service = new VisualService({ store, prefs, indexer: () => indexer, searcher: () => searcher, model: "m/clip", isModelCached: async () => options.cached === true });
  return { service, store, prefs, runs, searcher };
}

describe("ModelConsent", () => {
  it("needs consent unless granted for this exact model or the model is cached", async () => {
    const prefs = memoryPrefs();
    let cached = false;
    const consent = new ModelConsent({ prefs, pref: "p", model: "m1", isCached: async () => cached });
    expect(await consent.needed()).toBe(true);
    prefs.write("p", "m2");
    expect(await consent.needed()).toBe(true);
    consent.grant();
    expect(await consent.needed()).toBe(false);
    prefs.write("p", "");
    cached = true;
    expect(await consent.needed()).toBe(false);
  });
});

describe("VisualService consent gate", () => {
  it("refuses to index or embed (and never touches the model) until the user consents", async () => {
    const { service, runs, searcher } = setup();
    expect(await service.needsConsent()).toBe(true);
    await expect(service.gatedIndexer.index({ assetId: "a1" })).rejects.toBeInstanceOf(VisualConsentRequiredError);
    await expect(service.gatedSearcher.embedText("dog")).rejects.toBeInstanceOf(VisualConsentRequiredError);
    expect(await service.begin("a1")).toEqual({ status: "needs-consent" });
    expect(runs).toEqual([]);
    expect(searcher.queries).toEqual([]);
  });

  it("runs after consent is granted, persists consent via prefs only, and saves the embeddings", async () => {
    const { service, store, prefs, runs } = setup();
    service.grantConsent();
    expect(prefs.read(VISUAL_CONSENT_PREF, "", (v): v is string => typeof v === "string")).toBe("m/clip");
    const outcome = await service.begin("a1");
    expect(outcome.status).toBe("done");
    expect(runs).toEqual(["a1"]);
    expect((await store.get("a1"))?.times).toHaveLength(5);
    expect(await service.gatedSearcher.embedText("dog")).toBeInstanceOf(Float32Array);
  });

  it("does not ask when both halves of the model are already cached, and consent for another model does not carry over", async () => {
    const cached = setup({ cached: true });
    expect(await cached.service.needsConsent()).toBe(false);
    expect((await cached.service.begin("a1")).status).toBe("done");
    const other = setup();
    other.prefs.write(VISUAL_CONSENT_PREF, "other/model");
    expect(await other.service.needsConsent()).toBe(true);
  });

  it("tracks progress while running and clears it afterwards", async () => {
    const { service } = setup();
    service.grantConsent();
    const seen: number[] = [];
    service.state.subscribe(() => { const v = service.state.get().jobs.a1; if (v !== undefined) seen.push(v); });
    await service.begin("a1");
    expect(seen).toContain(0.5);
    expect(service.state.get().jobs).toEqual({});
  });

  it("maps an abort to a cancelled outcome and frees the job", async () => {
    const service = new VisualService({
      store: createMemoryVisualStore(), prefs: memoryPrefs(), model: "m", isModelCached: async () => true, searcher: () => fakeSearcher("m"),
      indexer: () => ({ index: ({ signal }) => new Promise((_, reject) => signal?.addEventListener("abort", () => reject(new DOMException("x", "AbortError")))) }),
    });
    const pending = service.begin("a1");
    await new Promise((r) => setTimeout(r, 0));
    service.cancel("a1");
    expect(await pending).toEqual({ status: "cancelled" });
    expect(service.state.get().jobs).toEqual({});
  });

  it("rejects a second concurrent index of the same asset", async () => {
    const service = new VisualService({
      store: createMemoryVisualStore(), prefs: memoryPrefs(), model: "m", isModelCached: async () => true, searcher: () => fakeSearcher("m"),
      indexer: () => ({ index: ({ signal }) => new Promise((_, reject) => signal?.addEventListener("abort", () => reject(new DOMException("x", "AbortError")))) }),
    });
    const first = service.begin("a1");
    await new Promise((r) => setTimeout(r, 0));
    expect(await service.begin("a1")).toMatchObject({ status: "error", message: expect.stringMatching(/already being indexed/) });
    service.cancel("a1");
    await first;
  });

  it("the agent's index_visuals and find_visual_moments fail with a message telling it to ask the user, and nothing is downloaded", async () => {
    const { service, runs, searcher, store } = setup();
    await store.save(makeEmbeddings({ assetId: "a1", model: "m/clip", frames: A1_FRAMES, cuts: A1_CUTS }));
    const { editor } = makeEditor({ assets: ASSETS });
    const tools = new Map(createVisualTools({ store: service.store, searcher: service.gatedSearcher, indexer: service.gatedIndexer }).map((t) => [t.name, t]));
    const ctx = { editor, nowMs: () => 0 };

    const index = await callTool({ tools, name: "index_visuals", args: { assetId: "a2" }, ctx });
    expect(index.ok).toBe(false);
    if (!index.ok) {
      expect(index.error).toMatch(/press Index visuals/);
      expect(index.hint).toMatch(/Do not retry until the user confirms/);
    }
    const find = await callTool({ tools, name: "find_visual_moments", args: { query: "dog", assetId: "a1" }, ctx });
    expect(find.ok).toBe(false);
    if (!find.ok) expect(find.error).toMatch(/press Index visuals/);
    expect(runs).toEqual([]);
    expect(searcher.queries).toEqual([]);

    service.grantConsent();
    const again = await callTool({ tools, name: "find_visual_moments", args: { query: "dog", assetId: "a1" }, ctx });
    expect(again.ok).toBe(true);
    const indexAgain = await callTool({ tools, name: "index_visuals", args: { assetId: "a2" }, ctx });
    expect(indexAgain.ok).toBe(true);
    expect(runs).toEqual(["a2"]);
  });
});
