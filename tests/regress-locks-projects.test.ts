import { describe, expect, it } from "vitest";
import {
  MemoryAssetRepository, MemoryProjectRepository, ProjectLockedError, ProjectsService, type ProjectLockHandle, type ProjectLocks,
} from "#/engine/persistence";
import { createProject, sequentialIds } from "#/engine/model";
import { WebProjectLocks, type LockManagerLike } from "#/platform/project-locks";
import { videoAsset } from "./helpers";

/** Minimal Web Locks semantics: exclusive, ifAvailable, held until the callback's promise settles. */
class FakeLockManager implements LockManagerLike {
  private readonly held = new Set<string>();
  async request(name: string, _o: { ifAvailable: true }, cb: (lock: unknown) => Promise<void> | undefined): Promise<unknown> {
    if (this.held.has(name)) return cb(null);
    this.held.add(name);
    try {
      return await cb({ name });
    } finally {
      this.held.delete(name);
    }
  }
}

describe("P0-5 project locks", () => {
  it("a second holder is refused until the first releases", async () => {
    const manager = new FakeLockManager();
    const a = new WebProjectLocks(manager);
    const b = new WebProjectLocks(manager);
    const first = await a.tryAcquire("p");
    expect(first).not.toBeNull();
    expect(await b.tryAcquire("p")).toBeNull();
    expect(await b.tryAcquire("other")).not.toBeNull();
    first?.release();
    await Promise.resolve();
    await Promise.resolve();
    expect(await b.tryAcquire("p")).not.toBeNull();
  });
});

const deniedLocks: ProjectLocks = { tryAcquire: async () => null };
const grantedLocks: ProjectLocks = { tryAcquire: async (): Promise<ProjectLockHandle> => ({ release: () => undefined }) };

function setup(locks?: ProjectLocks) {
  const projects = new MemoryProjectRepository();
  const assets = new MemoryAssetRepository();
  const ids = sequentialIds("n");
  const service = new ProjectsService({ projects, assets, newId: ids, now: () => "2026-01-01T00:00:00.000Z", locks });
  return { projects, assets, service, ids };
}

describe("P0-5 ProjectsService", () => {
  it("refuses to delete a project another tab has open", async () => {
    const { service, projects, assets } = setup(deniedLocks);
    const project = await service.create("P");
    await assets.save(project.metadata.id, { info: videoAsset("v1"), file: new Blob(["x"]) });
    await expect(service.delete([project.metadata.id])).rejects.toBeInstanceOf(ProjectLockedError);
    expect(await projects.load(project.metadata.id)).not.toBeNull();
    expect(await assets.list(project.metadata.id)).toHaveLength(1);
  });

  it("sweeps against the persisted project, so another tab's newer import survives a stale view", async () => {
    const { service, projects, assets } = setup(grantedLocks);
    const project = createProject({ id: "p", name: "P", ids: sequentialIds("x"), now: "2026-01-01T00:00:00.000Z" });
    await projects.save({ ...project, assetIds: ["keep", "imported-elsewhere"] });
    for (const id of ["keep", "imported-elsewhere", "orphan"]) await assets.save("p", { info: videoAsset(id), file: new Blob(["x"]) });
    await service.sweepOrphans("p");
    expect((await assets.list("p")).map((a) => a.id).sort()).toEqual(["imported-elsewhere", "keep"]);
  });
});

describe("P1-17 duplicate / delete ordering", () => {
  it("a failed media copy leaves no listed duplicate", async () => {
    const { service, projects, assets } = setup();
    const source = await service.create("Source");
    assets.copyAll = async () => { throw new Error("quota"); };
    await expect(service.duplicate([source.metadata.id])).rejects.toThrow("quota");
    expect(await projects.list()).toHaveLength(1);
  });

  it("delete removes the project row before the bytes", async () => {
    const { service, projects, assets } = setup();
    const project = await service.create("P");
    assets.removeAll = async () => { throw new Error("opfs"); };
    await expect(service.delete([project.metadata.id])).rejects.toThrow("opfs");
    expect(await projects.load(project.metadata.id)).toBeNull();
  });
});
