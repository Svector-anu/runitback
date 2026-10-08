import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it } from "vitest";
import { VISUAL_INDEX_VERSION } from "#/engine/visual";
import { IdbVisualStore, VISUAL_DB_NAME } from "#/platform/visual";
import { A1_CUTS, A1_FRAMES, makeEmbeddings } from "./visual-harness";

const embeddings = (assetId: string, model = "m/one") => makeEmbeddings({ assetId, model, frames: A1_FRAMES, cuts: A1_CUTS });

describe("IdbVisualStore", () => {
  it("round-trips embeddings by asset id with Float32 vectors, model and version intact, and misses cleanly", async () => {
    const store = new IdbVisualStore(new IDBFactory());
    await store.save(embeddings("a1"));
    const back = await store.get("a1");
    expect(back).toEqual(embeddings("a1"));
    expect(back?.vectors).toBeInstanceOf(Float32Array);
    expect(back?.model).toBe("m/one");
    expect(back?.version).toBe(VISUAL_INDEX_VERSION);
    expect(await store.get("nope")).toBeUndefined();
  });

  it("overwrites the embeddings of the same asset and deletes", async () => {
    const store = new IdbVisualStore(new IDBFactory());
    await store.save(embeddings("a1", "m/one"));
    await store.save(embeddings("a1", "m/two"));
    expect((await store.get("a1"))?.model).toBe("m/two");
    await store.delete("a1");
    expect(await store.get("a1")).toBeUndefined();
  });

  it("persists across store instances on the same factory, in the documented database", async () => {
    const factory = new IDBFactory();
    await new IdbVisualStore(factory).save(embeddings("a1"));
    expect(await new IdbVisualStore(factory).get("a1")).toBeDefined();
    expect((await factory.databases()).map((d) => d.name)).toContain(VISUAL_DB_NAME);
    expect(VISUAL_DB_NAME).toBe("runitback-visual");
  });

  it("keeps the assets independent", async () => {
    const store = new IdbVisualStore(new IDBFactory());
    await store.save(embeddings("a1"));
    await store.save(embeddings("a2"));
    await store.delete("a1");
    expect(await store.get("a2")).toBeDefined();
  });
});
