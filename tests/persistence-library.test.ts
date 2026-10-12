import { describe, expect, it } from "vitest";
import {
  MemoryAssetRepository, MemoryProjectRepository, ProjectChangedError, ProjectLockedError, ProjectsService, serializeProject,
  type ProjectLockHandle, type ProjectLocks,
} from "#/engine/persistence";
import { sequentialIds } from "#/engine/model";

const deniedLocks: ProjectLocks = { tryAcquire: async () => null };
const grantedLocks: ProjectLocks = { tryAcquire: async (): Promise<ProjectLockHandle> => ({ release: () => undefined }) };

function setup(locks: ProjectLocks = grantedLocks) {
  const projects = new MemoryProjectRepository();
  const assets = new MemoryAssetRepository();
  let tick = 0;
  const service = new ProjectsService({
    projects, assets, newId: sequentialIds("n"), now: () => `2026-01-01T00:00:${String(++tick).padStart(2, "0")}.000Z`, locks,
  });
  return { projects, assets, service };
}

describe("QA-P2-1 metadata writes respect project locks", () => {
  it("rename is refused while another tab has the project open and writes nothing", async () => {
    const { service, projects } = setup();
    const project = await service.create("Original");
    const refusing = new ProjectsService({ projects, assets: new MemoryAssetRepository(), newId: sequentialIds("m"), now: () => "2026-02-01T00:00:00.000Z", locks: deniedLocks });
    await expect(refusing.rename(project.metadata.id, "Renamed")).rejects.toBeInstanceOf(ProjectLockedError);
    expect((await projects.load(project.metadata.id))?.metadata.name).toBe("Original");
  });

  it("duplicate refuses a source another tab has open and creates nothing", async () => {
    const { projects, service } = setup();
    const source = await service.create("Source");
    const refusing = new ProjectsService({ projects, assets: new MemoryAssetRepository(), newId: sequentialIds("m"), now: () => "2026-02-01T00:00:00.000Z", locks: deniedLocks });
    await expect(refusing.duplicate([source.metadata.id])).rejects.toBeInstanceOf(ProjectLockedError);
    expect(await projects.list()).toHaveLength(1);
  });

  it("rename releases the lock, also when it fails", async () => {
    let held = 0;
    const locks: ProjectLocks = { tryAcquire: async () => { held++; return { release: () => { held--; } }; } };
    const { service } = setup(locks);
    await expect(service.rename("missing", "x")).rejects.toThrow("not found");
    expect(held).toBe(0);
  });

  it("a stale rename cannot overwrite an edit saved between its read and its write", async () => {
    const { service, projects } = setup();
    const project = await service.create("Original");
    const id = project.metadata.id;
    const realLoad = projects.load.bind(projects);
    projects.load = async (projectId) => {
      const loaded = await realLoad(projectId);
      await projects.save({ ...project, metadata: { ...project.metadata, updatedAt: "2026-03-01T00:00:00.000Z" }, assetIds: ["edited-elsewhere"] });
      return loaded;
    };
    await expect(service.rename(id, "Stale")).rejects.toBeInstanceOf(ProjectChangedError);
    projects.load = realLoad;
    const stored = await projects.load(id);
    expect(stored?.assetIds).toEqual(["edited-elsewhere"]);
    expect(stored?.metadata.name).toBe("Original");
  });

  it("a successful rename bumps updatedAt and keeps the rest of the document", async () => {
    const { service, projects } = setup();
    const project = await service.create("Original");
    await service.rename(project.metadata.id, "Renamed");
    const stored = await projects.load(project.metadata.id);
    expect(stored?.metadata.name).toBe("Renamed");
    expect((stored?.metadata.updatedAt ?? "") > project.metadata.updatedAt).toBe(true);
  });
});

describe("QA-P2-5 unreadable projects stay visible", () => {
  it("lists newer-version, damaged and empty rows next to readable projects, deleting nothing", async () => {
    const { service, projects } = setup();
    const ok = await service.create("Fine");
    const future = JSON.stringify({ ...JSON.parse(serializeProject(ok)), version: 999, metadata: { ...ok.metadata, name: "From the future" } });
    projects.putRaw("future", future);
    projects.putRaw("garbage", "{{{");
    projects.putRaw("empty", "");
    projects.putRaw("noscenes", JSON.stringify({ ...JSON.parse(serializeProject(ok)), scenes: null }));

    const { projects: readable, unreadable } = await service.listLibrary();
    expect(readable.map((p) => p.id)).toEqual([ok.metadata.id]);
    const byId = new Map(unreadable.map((u) => [u.id, u]));
    expect(byId.get("future")).toMatchObject({ reason: "newer-version", name: "From the future" });
    expect(byId.get("garbage")).toMatchObject({ reason: "damaged", name: null });
    expect(byId.get("empty")?.reason).toBe("damaged");
    expect(byId.get("noscenes")?.reason).toBe("damaged");
    expect(await service.loadRaw("garbage")).toBe("{{{");
    expect(await service.loadRaw("future")).toBe(future);
  });

  it("an unreadable row can be deleted through the normal path", async () => {
    const { service, projects } = setup();
    projects.putRaw("garbage", "{{{");
    await service.delete(["garbage"]);
    expect((await service.listLibrary()).unreadable).toEqual([]);
  });

  it("deleting an unreadable project is refused while another tab holds it", async () => {
    const { service, projects } = setup();
    projects.putRaw("garbage", "{{{");
    const refusing = new ProjectsService({ projects, assets: new MemoryAssetRepository(), newId: sequentialIds("m"), now: () => "t", locks: deniedLocks });
    await expect(refusing.delete(["garbage"])).rejects.toBeInstanceOf(ProjectLockedError);
    expect(await service.loadRaw("garbage")).toBe("{{{");
  });
});
