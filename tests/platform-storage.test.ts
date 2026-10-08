import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it } from "vitest";
import { createProject, sequentialIds } from "#/engine/model";
import { ProjectsService } from "#/engine/persistence";
import { MemoryFileStore, type FileStore } from "#/platform/file-store";
import { PrefsStore, isBoolean, isNumberArray } from "#/platform/prefs";
import { IdbAssetRepository, IdbProjectRepository, openOpenCutDatabase } from "#/platform/repositories";
import { videoAsset } from "./helpers";

const fresh = () => openOpenCutDatabase(new IDBFactory());

describe("IdbProjectRepository", () => {
  it("saves, loads, lists newest first and deletes", async () => {
    const repo = new IdbProjectRepository(fresh());
    const ids = sequentialIds("i");
    const a = createProject({ id: "a", name: "A", ids, now: "2026-01-01T00:00:00.000Z" });
    const b = createProject({ id: "b", name: "B", ids, now: "2026-02-01T00:00:00.000Z" });
    await repo.save(a);
    await repo.save(b);
    expect((await repo.list()).map((m) => m.id)).toEqual(["b", "a"]);
    expect(await repo.load("a")).toEqual(a);
    await repo.save({ ...a, metadata: { ...a.metadata, name: "A2" } });
    expect((await repo.load("a"))?.metadata.name).toBe("A2");
    await repo.delete("a");
    expect(await repo.load("a")).toBeNull();
  });
  it("skips unreadable rows instead of failing the list", async () => {
    const db = fresh();
    const repo = new IdbProjectRepository(db);
    await repo.save(createProject({ id: "ok", name: "ok", ids: sequentialIds(), now: "2026-01-01T00:00:00.000Z" }));
    await db.projects.put({ id: "bad", json: "{not json" });
    expect((await repo.list()).map((m) => m.id)).toEqual(["ok"]);
  });
});

const variants: Array<[string, () => FileStore | null]> = [["file store", () => new MemoryFileStore()], ["idb blobs", () => null]];

describe.each(variants)("IdbAssetRepository (%s)", (_name, makeFiles) => {
  it("keeps projects' media separate and round-trips bytes and metadata", async () => {
    const repo = new IdbAssetRepository(fresh(), makeFiles());
    const info = { ...videoAsset("v1"), fps: { numerator: 24000, denominator: 1001 }, hasAudio: false };
    await repo.save("p1", { info, file: new Blob(["hello"]) });
    await repo.save("p2", { info: videoAsset("v2"), file: new Blob(["other"]) });
    expect(await repo.list("p1")).toEqual([info]);
    expect(await (await repo.getFile("p1", "v1"))?.text()).toBe("hello");
    expect(await repo.getFile("p1", "v2")).toBeNull();
    await repo.remove("p1", "v1");
    expect(await repo.list("p1")).toEqual([]);
    expect(await repo.getFile("p1", "v1")).toBeNull();
    await repo.removeAll("p2");
    expect(await repo.list("p2")).toEqual([]);
  });
  it("persists fps and hasAudio, which classic dropped", async () => {
    const repo = new IdbAssetRepository(fresh(), makeFiles());
    const info = { ...videoAsset("v1"), fps: { numerator: 25, denominator: 1 }, hasAudio: false };
    await repo.save("p", { info, file: new Blob(["x"]) });
    const [loaded] = await repo.list("p");
    expect(loaded?.fps).toEqual({ numerator: 25, denominator: 1 });
    expect(loaded?.hasAudio).toBe(false);
  });
  it("copyAll duplicates bytes and metadata", async () => {
    const repo = new IdbAssetRepository(fresh(), makeFiles());
    await repo.save("p", { info: videoAsset("v1"), file: new Blob(["abc"]) });
    await repo.copyAll("p", "q");
    expect(await (await repo.getFile("q", "v1"))?.text()).toBe("abc");
    expect((await repo.list("q")).map((a) => a.id)).toEqual(["v1"]);
  });
  it("works end to end with ProjectsService.duplicate", async () => {
    const db = fresh();
    const assets = new IdbAssetRepository(db, makeFiles());
    const projects = new IdbProjectRepository(db);
    const svc = new ProjectsService({ projects, assets, newId: sequentialIds("z"), now: () => "2026-03-01T00:00:00.000Z" });
    const p = await svc.create("Trip");
    await assets.save(p.metadata.id, { info: videoAsset("m"), file: new Blob(["m"]) });
    const [copy] = await svc.duplicate([p.metadata.id]);
    expect(await assets.getFile(copy!, "m")).not.toBeNull();
    await svc.delete([p.metadata.id]);
    expect(await assets.getFile(p.metadata.id, "m")).toBeNull();
    expect(await assets.getFile(copy!, "m")).not.toBeNull();
  });
});

describe("PrefsStore", () => {
  it("validates stored values and survives corrupt data", () => {
    const data = new Map<string, string>();
    const prefs = new PrefsStore({ getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) });
    expect(prefs.read("snap", true, isBoolean)).toBe(true);
    prefs.write("snap", false);
    expect(prefs.read("snap", true, isBoolean)).toBe(false);
    data.set("opencut:sizes", "[1,\"x\"]");
    expect(prefs.read("sizes", [25, 50, 25], isNumberArray)).toEqual([25, 50, 25]);
    data.set("opencut:sizes", "{broken");
    expect(prefs.read("sizes", [25, 50, 25], isNumberArray)).toEqual([25, 50, 25]);
  });
});
