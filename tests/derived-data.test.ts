import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it } from "vitest";
import { MEDIA_ANALYSIS_VERSION } from "#/engine/analysis";
import { IdbAnalysisStore, MemoryAnalysisStore, analysisCacheKey } from "#/platform/analysis";
import { DerivedDataPurgeError, DerivedDataRegistry, type DerivedDataStore } from "#/platform/derived-data";
import { SMALL_EMBEDDINGS_BYTES, analysisAdapter, faceAdapter, transcriptAdapter, visualAdapter } from "#/platform/derived-data-adapters";
import { IdbTranscriptStore } from "#/platform/transcribe";
import { IdbFaceStore, IdbVisualStore } from "#/platform/visual";
import { detections, A1_FACE_FRAMES } from "./face-harness";
import { videoAsset } from "./helpers";
import { transcriptOf, TALK_WORDS } from "./transcript-harness";
import { A1_FRAMES, makeEmbeddings } from "./visual-harness";
import { makeAnalysis } from "./temporal-harness";

const info = (id: string) => ({ ...videoAsset(id), size: 111, lastModified: 222 });

describe("IdbAnalysisStore per-asset deletion", () => {
  it("removes every key of one asset and nothing of an asset whose id merely starts the same way", async () => {
    const store = new IdbAnalysisStore(new IDBFactory());
    await store.put(analysisCacheKey({ id: "a1", size: 1, lastModified: 1 }), makeAnalysis({ assetId: "a1" }));
    await store.put(analysisCacheKey({ id: "a1", size: 2, lastModified: 2 }), makeAnalysis({ assetId: "a1" }));
    await store.put(analysisCacheKey({ id: "a10", size: 1, lastModified: 1 }), makeAnalysis({ assetId: "a10" }));
    expect((await store.assetIds()).sort()).toEqual(["a1", "a10"]);
    await store.deleteAsset("a1");
    expect(await store.assetIds()).toEqual(["a10"]);
    expect(await store.get(analysisCacheKey({ id: "a10", size: 1, lastModified: 1 }))).toBeDefined();
  });

  it("is a no-op for an unknown asset, and the in-memory store behaves the same", async () => {
    const idb = new IdbAnalysisStore(new IDBFactory());
    const memory = new MemoryAnalysisStore();
    for (const store of [idb, memory]) {
      await store.put(analysisCacheKey({ id: "a1", size: 1, lastModified: 1 }), makeAnalysis());
      await store.deleteAsset("zzz");
      expect(await store.assetIds()).toEqual(["a1"]);
      await store.deleteAsset("a1");
      expect(await store.assetIds()).toEqual([]);
    }
  });
});

describe("per-asset stores list their asset ids", () => {
  it("transcripts, embeddings and faces", async () => {
    const factory = new IDBFactory();
    const transcripts = new IdbTranscriptStore(factory);
    const visual = new IdbVisualStore(factory);
    const faces = new IdbFaceStore(factory);
    await transcripts.save(transcriptOf("a1", TALK_WORDS));
    await transcripts.save(transcriptOf("a2", TALK_WORDS));
    await visual.save(makeEmbeddings({ assetId: "a1", frames: A1_FRAMES }));
    await faces.save(detections({ assetId: "a3", frames: A1_FACE_FRAMES }));
    expect((await transcripts.assetIds()).sort()).toEqual(["a1", "a2"]);
    expect(await visual.assetIds()).toEqual(["a1"]);
    expect(await faces.assetIds()).toEqual(["a3"]);
    await transcripts.delete("a1");
    expect(await transcripts.assetIds()).toEqual(["a2"]);
  });
});

function fullRegistry(): { registry: DerivedDataRegistry; analysis: IdbAnalysisStore; transcripts: IdbTranscriptStore; visual: IdbVisualStore; faces: IdbFaceStore } {
  const factory = new IDBFactory();
  const analysis = new IdbAnalysisStore(factory);
  const transcripts = new IdbTranscriptStore(factory);
  const visual = new IdbVisualStore(factory);
  const faces = new IdbFaceStore(factory);
  const registry = new DerivedDataRegistry()
    .register(analysisAdapter(analysis)).register(transcriptAdapter(transcripts)).register(visualAdapter(visual)).register(faceAdapter(faces));
  return { registry, analysis, transcripts, visual, faces };
}

async function seed(h: ReturnType<typeof fullRegistry>, assetId: string): Promise<void> {
  await h.analysis.put(analysisCacheKey(info(assetId)), makeAnalysis({ assetId }));
  await h.transcripts.save(transcriptOf(assetId, TALK_WORDS));
  await h.visual.save(makeEmbeddings({ assetId, frames: A1_FRAMES }));
  await h.faces.save(detections({ assetId, frames: A1_FACE_FRAMES }));
}

describe("DerivedDataRegistry", () => {
  it("purges one asset from every store and leaves the others", async () => {
    const h = fullRegistry();
    await seed(h, "a1");
    await seed(h, "a2");
    await h.registry.purgeAsset("a1");
    expect(await h.analysis.get(analysisCacheKey(info("a1")))).toBeUndefined();
    expect(await h.transcripts.get("a1")).toBeUndefined();
    expect(await h.visual.get("a1")).toBeUndefined();
    expect(await h.faces.get("a1")).toBeUndefined();
    expect(await h.transcripts.get("a2")).toBeDefined();
    expect(await h.faces.get("a2")).toBeDefined();
    expect((await h.registry.listAssetIds()).sort()).toEqual(["a2"]);
  });

  it("purges many assets at once", async () => {
    const h = fullRegistry();
    for (const id of ["a1", "a2", "a3"]) await seed(h, id);
    await h.registry.purgeAssets(["a1", "a3", "a1"]);
    expect(await h.registry.listAssetIds()).toEqual(["a2"]);
  });

  it("keeps purging the other stores when one fails, then reports the failure", async () => {
    const h = fullRegistry();
    await seed(h, "a1");
    const broken: DerivedDataStore = {
      kind: "analysis", deleteAsset: async () => { throw new Error("disk"); }, assetIds: async () => [],
      exportAsset: async () => undefined, importAsset: async () => false,
    };
    const registry = new DerivedDataRegistry().register(transcriptAdapter(h.transcripts)).register(faceAdapter(h.faces)).register(broken);
    const error = await registry.purgeAssets(["a1"]).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DerivedDataPurgeError);
    expect((error as DerivedDataPurgeError).failures.map((f) => f.kind)).toEqual(["analysis"]);
    expect(await h.transcripts.get("a1")).toBeUndefined();
    expect(await h.faces.get("a1")).toBeUndefined();
  });

  it("refuses to register a kind twice", () => {
    const h = fullRegistry();
    expect(() => h.registry.register(transcriptAdapter(h.transcripts))).toThrow(/already registered/);
  });
});

describe("derived data adapters round trip", () => {
  it("exports and imports every kind under a new asset id", async () => {
    const source = fullRegistry();
    await seed(source, "old");
    const target = fullRegistry();
    const renamed = { ...info("new") };
    for (const store of source.registry.stores) {
      const payload = await store.exportAsset(info("old"), { includeEmbeddings: false });
      expect(payload, store.kind).toBeDefined();
      const json: unknown = JSON.parse(JSON.stringify(payload));
      expect(await target.registry.store(store.kind)?.importAsset(renamed, json), store.kind).toBe(true);
    }
    expect((await target.transcripts.get("new"))?.assetId).toBe("new");
    expect(await target.transcripts.get("old")).toBeUndefined();
    expect((await target.faces.get("new"))?.frames).toHaveLength(A1_FACE_FRAMES.length);
    const embeddings = await target.visual.get("new");
    expect(embeddings?.assetId).toBe("new");
    expect(Array.from(embeddings?.vectors ?? [])).toEqual(Array.from(makeEmbeddings({ frames: A1_FRAMES }).vectors));
    expect(await target.analysis.get(analysisCacheKey(renamed))).toBeDefined();
    expect((await target.analysis.get(analysisCacheKey(renamed)))?.version).toBe(MEDIA_ANALYSIS_VERSION);
  });

  it("skips large embeddings unless asked, and rejects unusable payloads without throwing", async () => {
    const h = fullRegistry();
    const dimensions = 512;
    const rows = Math.ceil(SMALL_EMBEDDINGS_BYTES / (dimensions * 4)) + 1;
    await h.visual.save({
      version: 1, assetId: "big", model: "m", dimensions, durationSeconds: 1, cuts: [], times: Array.from({ length: rows }, (_, i) => i), vectors: new Float32Array(rows * dimensions),
    });
    const store = h.registry.store("visual")!;
    expect(await store.exportAsset(info("big"), { includeEmbeddings: false })).toBeUndefined();
    expect(await store.exportAsset(info("big"), { includeEmbeddings: true })).toBeDefined();

    expect(await store.importAsset(info("x"), { version: 1, model: "m", dimensions: 2, durationSeconds: 1, cuts: [], times: [0], vectorsBase64: "AAAA" })).toBe(false);
    expect(await h.registry.store("transcript")?.importAsset(info("x"), { version: 99 })).toBe(false);
    expect(await h.registry.store("transcript")?.importAsset(info("x"), "nope")).toBe(false);
    expect(await h.registry.store("faces")?.importAsset(info("x"), { version: 1, model: "m", durationSeconds: 1, frames: [{ t: 0, boxes: [{ x: "bad" }] }] })).toBe(false);
    expect(await h.registry.store("analysis")?.importAsset(info("x"), { version: 99 })).toBe(false);
    expect(await h.registry.listAssetIds()).toEqual(["big"]);
  });
});
