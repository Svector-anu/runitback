import { describe, expect, it, vi } from "vitest";
import { AppServices, type AppServicesDeps } from "#/app/services";
import { MemoryAssetRepository, MemoryProjectRepository } from "#/engine/persistence";
import { createProject, sequentialIds, type MediaAssetInfo } from "#/engine/model";
import { allElements, documentViolations } from "#/engine/timeline";
import { MediaRuntime } from "#/platform/media-runtime";
import { video, videoAsset } from "./helpers";

function setup(): { services: AppServices; projects: MemoryProjectRepository } {
  const projects = new MemoryProjectRepository();
  const deps: AppServicesDeps = {
    projectRepository: projects, assetRepository: new MemoryAssetRepository(),
    locks: { tryAcquire: async () => ({ release: () => undefined }) }, storageMode: "indexeddb",
    createRuntime: () => new MediaRuntime(),
    createAudioEngine: () => ({ attach: () => undefined, restart: () => undefined, dispose: () => undefined }),
    probe: vi.fn(async (file: File, id: string): Promise<MediaAssetInfo> => ({ ...videoAsset(id), name: file.name })),
  };
  return { services: new AppServices(deps), projects };
}

describe("P1-14 an already damaged project opens, is repaired once and stays repaired", () => {
  it("reports the repairs a single time and persists the fixed project", async () => {
    const { services, projects } = setup();
    const project = createProject({ id: "bad", name: "Bad", ids: sequentialIds("b"), now: "2026-01-01T00:00:00.000Z" });
    project.scenes[0]!.tracks.main.elements.push(video("a", 0, 5), video("b", 2, 5), { ...video("c", 9, 1), startTime: -40 as never });
    await projects.save(project);

    await services.openProject("bad");
    const notes = services.takeRepairNotes();
    expect(notes.length).toBeGreaterThanOrEqual(2);
    expect(services.takeRepairNotes()).toEqual([]);
    expect(documentViolations(services.editor.getState().doc).filter((v) => /overlap|negative/.test(v))).toEqual([]);

    await services.closeProject();
    const stored = await projects.load("bad");
    expect(stored?.repairNotes).toBeUndefined();
    const scene = stored!.scenes[0]!;
    expect(allElements(scene.tracks).map((l) => l.element.id).sort()).toEqual(["a", "b", "c"]);

    await services.openProject("bad");
    expect(services.takeRepairNotes()).toEqual([]);
  });

  it("StrictMode shape (open, close, open) still reports the repairs even though the first open already saved the fix", async () => {
    const { services, projects } = setup();
    const project = createProject({ id: "bad", name: "Bad", ids: sequentialIds("b"), now: "2026-01-01T00:00:00.000Z" });
    project.scenes[0]!.tracks.main.elements.push(video("a", 0, 5), video("b", 2, 5));
    await projects.save(project);
    const first = services.openProject("bad");
    const close = services.closeProject();
    const second = services.openProject("bad");
    await Promise.all([first, close, second]);
    expect(services.takeRepairNotes().length).toBeGreaterThanOrEqual(1);
    expect(services.takeRepairNotes()).toEqual([]);
  });

  it("a sound project reports nothing and is not dirtied by opening", async () => {
    const { services, projects } = setup();
    await projects.save(createProject({ id: "ok", name: "Ok", ids: sequentialIds("o"), now: "2026-01-01T00:00:00.000Z" }));
    await services.openProject("ok");
    expect(services.takeRepairNotes()).toEqual([]);
    expect(services.saveManager.isDirty).toBe(false);
  });
});
