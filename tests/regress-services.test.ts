import { describe, expect, it, vi } from "vitest";
import { AppServices, type AppServicesDeps, type AudioEngineLike } from "#/app/services";
import {
  MemoryAssetRepository, MemoryProjectRepository, ProjectLockedError, SaveFailedError, type ProjectLockHandle, type ProjectLocks,
} from "#/engine/persistence";
import { createProject, sequentialIds, type MediaAssetInfo } from "#/engine/model";
import { MediaRuntime } from "#/platform/media-runtime";
import { videoAsset } from "./helpers";

class FakeLocks implements ProjectLocks {
  readonly held = new Set<string>();
  async tryAcquire(id: string): Promise<ProjectLockHandle | null> {
    if (this.held.has(id)) return null;
    this.held.add(id);
    return { release: () => void this.held.delete(id) };
  }
}

class GatedProjectRepository extends MemoryProjectRepository {
  readonly gates = new Map<string, Promise<void>>();
  override async load(id: string): ReturnType<MemoryProjectRepository["load"]> {
    await this.gates.get(id);
    return super.load(id);
  }
}

interface Harness {
  services: AppServices;
  projects: GatedProjectRepository;
  assets: MemoryAssetRepository;
  locks: FakeLocks;
  engines: Array<AudioEngineLike & { restarts: number; disposed: boolean }>;
  probe: ReturnType<typeof vi.fn>;
}

async function harness(projectIds: string[] = ["A", "B"]): Promise<Harness> {
  const projects = new GatedProjectRepository();
  const assets = new MemoryAssetRepository();
  const locks = new FakeLocks();
  const engines: Harness["engines"] = [];
  const probe = vi.fn(async (file: File, id: string): Promise<MediaAssetInfo> => ({ ...videoAsset(id), name: file.name }));
  const deps: AppServicesDeps = {
    projectRepository: projects, assetRepository: assets, locks, storageMode: "indexeddb",
    createRuntime: () => new MediaRuntime(),
    createAudioEngine: () => {
      const engine = { restarts: 0, disposed: false, attach: () => undefined, restart() { this.restarts++; }, dispose() { this.disposed = true; } };
      engines.push(engine);
      return engine;
    },
    probe,
  };
  for (const id of projectIds) {
    await projects.save(createProject({ id, name: id, ids: sequentialIds(id), now: "2026-01-01T00:00:00.000Z" }));
  }
  return { services: new AppServices(deps), projects, assets, locks, engines, probe };
}

const gate = (): { promise: Promise<void>; open: () => void } => {
  let open!: () => void;
  const promise = new Promise<void>((r) => { open = r; });
  return { promise, open };
};

describe("P1-2 open/close serialisation", () => {
  it("the last requested project wins even when an earlier load finishes last", async () => {
    const h = await harness();
    const slowA = gate();
    h.projects.gates.set("A", slowA.promise);
    const openA = h.services.openProject("A");
    const openB = h.services.openProject("B");
    slowA.open();
    await Promise.all([openA, openB]);
    expect(h.services.currentProjectId).toBe("B");
    expect(h.services.editor.getState().meta?.id).toBe("B");
    expect(h.locks.held).toEqual(new Set(["B"]));
  });

  it("StrictMode shape open, close, open ends with the project open exactly once", async () => {
    const h = await harness();
    const first = h.services.openProject("A");
    const close = h.services.closeProject();
    const second = h.services.openProject("A");
    await Promise.all([first, close, second]);
    expect(h.services.currentProjectId).toBe("A");
    expect(h.locks.held).toEqual(new Set(["A"]));
    expect(h.engines.filter((e) => !e.disposed)).toHaveLength(1);
  });

  it("a failed open does not wedge the queue and releases its lock", async () => {
    const h = await harness(["A"]);
    await expect(h.services.openProject("missing")).rejects.toThrow();
    expect(h.locks.held.size).toBe(0);
    await h.services.openProject("A");
    expect(h.services.currentProjectId).toBe("A");
  });
});

describe("P0-5 second tab", () => {
  it("refuses to open a project another tab holds", async () => {
    const h = await harness();
    await h.locks.tryAcquire("A");
    await expect(h.services.openProject("A")).rejects.toBeInstanceOf(ProjectLockedError);
    expect(h.services.editor.hasProject).toBe(false);
  });
});

describe("P1-1 import targets the project it started for", () => {
  it("does not register into a project opened while the import was probing", async () => {
    const h = await harness();
    await h.services.openProject("A");
    const probing = gate();
    h.probe.mockImplementationOnce(async (file: File, id: string) => {
      await probing.promise;
      return { ...videoAsset(id), name: file.name };
    });
    const importing = h.services.importFiles([new File(["x"], "late.mp4")]);
    await h.services.closeProject();
    await h.services.openProject("B");
    probing.open();
    const outcome = await importing;
    expect(outcome.imported).toEqual([]);
    expect(outcome.failures).toHaveLength(1);
    expect(h.services.editor.getState().doc.assets).toEqual([]);
    expect(await h.assets.list("A")).toEqual([]);
    expect(await h.assets.list("B")).toEqual([]);
  });

  it("removes bytes stored for a project that closed during the write", async () => {
    const h = await harness();
    await h.services.openProject("A");
    const saving = gate();
    const save = h.assets.save.bind(h.assets);
    h.assets.save = async (projectId, asset) => { await saving.promise; await save(projectId, asset); };
    const importing = h.services.importFiles([new File(["x"], "late.mp4")]);
    await vi.waitFor(() => expect(h.probe).toHaveBeenCalled());
    const closing = h.services.closeProject();
    await closing;
    saving.open();
    const outcome = await importing;
    expect(outcome.imported).toEqual([]);
    expect(await h.assets.list("A")).toEqual([]);
  });
});

describe("P0-4 closeProject", () => {
  it("still saves the last edit when the thumbnail render fails", async () => {
    const h = await harness();
    await h.services.openProject("A");
    vi.spyOn(h.services, "updateThumbnail").mockRejectedValue(new Error("decode failed"));
    h.services.editor.updateMetadata({ name: "edited" });
    await h.services.closeProject();
    expect((await h.projects.load("A"))?.metadata.name).toBe("edited");
    expect(h.services.editor.hasProject).toBe(false);
  });

  it("keeps the project open and its media when saving fails", async () => {
    const h = await harness();
    await h.services.openProject("A");
    vi.spyOn(h.services, "updateThumbnail").mockResolvedValue();
    h.services.editor.updateMetadata({ name: "edited" });
    h.projects.failNextSaves = 10;
    await expect(h.services.closeProject()).rejects.toBeInstanceOf(SaveFailedError);
    expect(h.services.editor.hasProject).toBe(true);
    expect(h.locks.held).toEqual(new Set(["A"]));
  });
});

describe("P0-6 exports are tied to the project", () => {
  it("closing the project aborts a tracked export", async () => {
    const h = await harness();
    await h.services.openProject("A");
    vi.spyOn(h.services, "updateThumbnail").mockResolvedValue();
    const controller = new AbortController();
    h.services.trackExport(controller);
    await h.services.closeProject();
    expect(controller.signal.aborted).toBe(true);
  });
});

describe("P1-3 / P1-4 audio engine lifecycle", () => {
  it("only the live project's engine reacts to edits, and stale ones are disposed", async () => {
    const h = await harness();
    vi.spyOn(h.services, "updateThumbnail").mockResolvedValue();
    await h.services.openProject("A");
    await h.services.openProject("B");
    const [stale, live] = h.engines;
    expect(stale?.disposed).toBe(true);
    vi.spyOn(h.services.editor.playback, "getState").mockReturnValue({ ...h.services.editor.playback.getState(), isPlaying: true });
    h.services.editor.registerAsset(videoAsset("late"));
    expect(stale?.restarts).toBe(0);
    expect(live?.restarts).toBe(1);
  });

  it("view-state writes do not restart audio during playback", async () => {
    const h = await harness();
    await h.services.openProject("A");
    vi.spyOn(h.services.editor.playback, "getState").mockReturnValue({ ...h.services.editor.playback.getState(), isPlaying: true });
    h.services.editor.setViewState({ scrollLeft: 900 });
    h.services.editor.setViewState({ zoomLevel: 4 });
    expect(h.engines[0]?.restarts).toBe(0);
  });
});
