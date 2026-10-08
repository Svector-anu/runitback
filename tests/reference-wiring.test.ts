import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it } from "vitest";
import { IdbStyleProfileStore, createAnalysisProvider } from "#/app/agent/reference-wiring";
import { MemoryAnalysisStore } from "#/platform/analysis";
import type { StoredStyleProfile } from "#/engine/reference";
import { makeEditor } from "./helpers";

const entry = (id: string, createdAtMs: number): StoredStyleProfile =>
  ({ id, name: id, createdAtMs, profile: { version: 1 } as unknown as StoredStyleProfile["profile"] });

describe("IdbStyleProfileStore", () => {
  it("round-trips profiles and lists them oldest first", async () => {
    const store = new IdbStyleProfileStore(new IDBFactory());
    await store.save(entry("b", 2));
    await store.save(entry("a", 1));
    expect((await store.list()).map((p) => p.id)).toEqual(["a", "b"]);
    expect((await store.get("b"))?.createdAtMs).toBe(2);
    expect(await store.get("nope")).toBeUndefined();
  });
  it("overwrites by id", async () => {
    const store = new IdbStyleProfileStore(new IDBFactory());
    await store.save(entry("a", 1));
    await store.save({ ...entry("a", 5), name: "renamed" });
    expect(await store.list()).toHaveLength(1);
    expect((await store.get("a"))?.name).toBe("renamed");
  });
});

describe("createAnalysisProvider", () => {
  it("returns undefined for unknown assets or missing bytes instead of throwing", async () => {
    const { editor } = makeEditor();
    const provider = createAnalysisProvider({
      editor, runtime: () => ({ getBlob: () => undefined }) as never, analysisStore: () => new MemoryAnalysisStore(),
    });
    expect(await provider.get("missing")).toBeUndefined();
  });
});
