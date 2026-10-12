import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it } from "vitest";
import { createProject, sequentialIds } from "#/engine/model";
import { serializeProject } from "#/engine/persistence";
import { IdbProjectRepository, openAppDatabase } from "#/platform/repositories";

function repo() {
  const db = openAppDatabase(new IDBFactory());
  return { db, repo: new IdbProjectRepository(db) };
}
const base = () => createProject({ id: "p", name: "P", ids: sequentialIds("x"), now: "2026-01-01T00:00:00.000Z" });

describe("IdbProjectRepository library", () => {
  it("reports unreadable rows instead of dropping them, and loadRaw returns them verbatim", async () => {
    const { db, repo: r } = repo();
    await r.save(base());
    await db.projects.put({ id: "bad", json: "{{{" });
    await db.projects.put({ id: "future", json: JSON.stringify({ ...JSON.parse(serializeProject(base())), version: 999 }) });
    const { projects, unreadable } = await r.listLibrary();
    expect(projects.map((p) => p.id)).toEqual(["p"]);
    expect(unreadable.map((u) => [u.id, u.reason]).sort()).toEqual([["bad", "damaged"], ["future", "newer-version"]]);
    expect(await r.loadRaw("bad")).toBe("{{{");
    expect(await r.loadRaw("nope")).toBeNull();
  });

  it("saveIfUnchanged writes only when updatedAt still matches", async () => {
    const { repo: r } = repo();
    const p = base();
    await r.save(p);
    const next = { ...p, metadata: { ...p.metadata, name: "A", updatedAt: "2026-01-02T00:00:00.000Z" } };
    expect(await r.saveIfUnchanged(next, p.metadata.updatedAt)).toBe(true);
    const stale = { ...p, metadata: { ...p.metadata, name: "B", updatedAt: "2026-01-03T00:00:00.000Z" } };
    expect(await r.saveIfUnchanged(stale, p.metadata.updatedAt)).toBe(false);
    expect((await r.load("p"))?.metadata.name).toBe("A");
    expect(await r.saveIfUnchanged({ ...p, metadata: { ...p.metadata, id: "gone" } }, "x")).toBe(false);
  });
});
