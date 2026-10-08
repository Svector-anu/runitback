import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sequentialIds, createProject } from "#/engine/model";
import { insertMediaElement } from "#/engine/commands";
import {
  MemoryAssetRepository, MemoryProjectRepository, ProjectsService, SaveManager, STORAGE_HEADROOM_BYTES, canStoreFile,
  deserializeProject, duplicateName, filterProjects, isQuotaExceededError, migrateProject, serializeProject, sortProjects,
  ProjectFormatError,
} from "#/engine/persistence";
import { allElements } from "#/engine/timeline";
import { makeEditor, sec, videoAsset } from "./helpers";

describe("serialization", () => {
  it("round-trips a project with edits, keyframes and view state", () => {
    const { editor, project } = makeEditor({ assets: [videoAsset("a1")] });
    editor.execute(insertMediaElement({ asset: videoAsset("a1"), elementId: "c1", startTime: 0, placement: { mode: "auto" } }));
    editor.setViewState({ zoomLevel: 3, scrollLeft: 120 });
    editor.playback.seek(sec(2));
    const saved = editor.toProject();
    const restored = deserializeProject(serializeProject(saved));
    expect(restored).toEqual(saved);
    expect(restored.timelineViewState).toMatchObject({ zoomLevel: 3, scrollLeft: 120, playheadTime: sec(2) });
    expect(restored.assetIds).toEqual(["asset-a1".replace("asset-", "")]);
    expect(project.metadata.id).toBe(restored.metadata.id);
    expect(restored.metadata.duration).toBe(sec(10));
  });
  it("rejects malformed or future-version projects with a readable error", () => {
    expect(() => deserializeProject("{}")).toThrow(ProjectFormatError);
    expect(() => deserializeProject({ version: 99, metadata: {}, scenes: [] })).toThrow(/newer version/);
    expect(() => deserializeProject({ version: 1, metadata: { id: "x", name: "n" }, scenes: [] })).toThrow(/no scenes/);
  });
  it("repairs a stale current scene and missing view state", () => {
    const project = createProject({ id: "p", name: "n", ids: sequentialIds(), now: "2026-01-01T00:00:00.000Z" });
    const broken = { ...project, currentSceneId: "gone", timelineViewState: undefined, assetIds: undefined };
    const restored = deserializeProject(JSON.stringify(broken));
    expect(restored.currentSceneId).toBe(project.scenes[0]?.id);
    expect(restored.timelineViewState.zoomLevel).toBe(1);
    expect(restored.assetIds).toEqual([]);
  });
  it("migrations run in order and are additive", () => {
    const migrations = [
      { from: 0, to: 1, run: (p: Record<string, unknown>) => ({ ...p, a: 1 }) },
      { from: 1, to: 2, run: (p: Record<string, unknown>) => ({ ...p, b: 2 }) },
    ];
    const out = migrateProject({ version: 0, keep: true }, migrations, 2);
    expect(out).toEqual({ version: 2, keep: true, a: 1, b: 2 });
    expect(() => migrateProject({ version: 0 }, [], 2)).toThrow(/No migration/);
  });
});

describe("quota", () => {
  it("allows when unknown and enforces 50MiB headroom when known", () => {
    expect(canStoreFile({ size: 1e12 }).canStore).toBe(true);
    expect(canStoreFile({ size: 1000, usage: 0, quota: STORAGE_HEADROOM_BYTES + 1000 }).canStore).toBe(true);
    expect(canStoreFile({ size: 1001, usage: 0, quota: STORAGE_HEADROOM_BYTES + 1000 }).canStore).toBe(false);
    expect(isQuotaExceededError(Object.assign(new Error("x"), { name: "QuotaExceededError" }))).toBe(true);
    expect(isQuotaExceededError(new Error("disk quota hit"))).toBe(true);
    expect(isQuotaExceededError("nope")).toBe(false);
  });
});

describe("ProjectsService", () => {
  function service() {
    const projects = new MemoryProjectRepository();
    const assets = new MemoryAssetRepository();
    let n = 0;
    const svc = new ProjectsService({ projects, assets, newId: sequentialIds("s"), now: () => `2026-01-01T00:00:0${n++ % 10}.000Z` });
    return { svc, projects, assets };
  }
  it("create, list, rename", async () => {
    const { svc } = service();
    const p = await svc.create("Holiday");
    await svc.rename(p.metadata.id, "Holiday 2");
    const list = await svc.list();
    expect(list.map((m) => m.name)).toEqual(["Holiday 2"]);
    await expect(svc.rename("nope", "x")).rejects.toThrow(/not found/);
  });
  it("duplicate numbers copies and copies media", async () => {
    const { svc, assets } = service();
    const p = await svc.create("Trip");
    await assets.save(p.metadata.id, { info: videoAsset("m1"), file: new Blob(["x"]) });
    const [c1] = await svc.duplicate([p.metadata.id]);
    const [c2] = await svc.duplicate([p.metadata.id]);
    const names = (await svc.list()).map((m) => m.name).sort();
    expect(names).toEqual(["(1) Trip", "(2) Trip", "Trip"]);
    expect((await assets.list(c1!)).length).toBe(1);
    expect(c1).not.toBe(c2);
    expect(duplicateName("(2) Trip", ["Trip", "(2) Trip"])).toBe("(3) Trip");
  });
  it("delete removes the project and its media", async () => {
    const { svc, assets, projects } = service();
    const p = await svc.create("Gone");
    await assets.save(p.metadata.id, { info: videoAsset("m1"), file: new Blob(["x"]) });
    await svc.delete([p.metadata.id]);
    expect(await projects.load(p.metadata.id)).toBeNull();
    expect(await assets.list(p.metadata.id)).toEqual([]);
  });
  it("loads only listed assets and collects orphans", async () => {
    const { svc, assets } = service();
    const p = await svc.create("A");
    await assets.save(p.metadata.id, { info: videoAsset("keep"), file: new Blob(["x"]) });
    await assets.save(p.metadata.id, { info: videoAsset("drop"), file: new Blob(["y"]) });
    const withList = { ...p, assetIds: ["keep"] };
    expect((await svc.loadAssets(withList)).map((a) => a.id)).toEqual(["keep"]);
    await svc.collectOrphans(withList);
    expect((await assets.list(p.metadata.id)).map((a) => a.id)).toEqual(["keep"]);
  });
  it("sorts and filters", () => {
    const m = (name: string, updatedAt: string, duration: number) => ({ id: name, name, duration: duration as never, createdAt: updatedAt, updatedAt });
    const list = [m("b", "2026-01-02", 5), m("A", "2026-01-03", 1), m("c", "2026-01-01", 9)];
    expect(sortProjects(list, "name", "asc").map((p) => p.name)).toEqual(["A", "b", "c"]);
    expect(sortProjects(list, "updatedAt", "desc").map((p) => p.name)).toEqual(["A", "b", "c"]);
    expect(sortProjects(list, "duration", "desc").map((p) => p.name)).toEqual(["c", "b", "A"]);
    expect(filterProjects(list, "  B ").map((p) => p.name)).toEqual(["b"]);
  });
});

describe("SaveManager", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function setup() {
    const { editor } = makeEditor({ assets: [videoAsset("a1")] });
    const repo = new MemoryProjectRepository();
    const manager = new SaveManager({ editor, repository: repo });
    manager.start();
    return { editor, repo, manager };
  }
  const edit = (editor: ReturnType<typeof setup>["editor"], id: string) =>
    editor.execute(insertMediaElement({ asset: videoAsset("a1"), elementId: id, startTime: 0, placement: { mode: "auto" } }));

  it("debounces bursts into one save after 800ms", async () => {
    const { editor, repo } = setup();
    edit(editor, "c1");
    await vi.advanceTimersByTimeAsync(700);
    edit(editor, "c2");
    await vi.advanceTimersByTimeAsync(700);
    expect(repo.saveCount).toBe(0);
    await vi.advanceTimersByTimeAsync(200);
    expect(repo.saveCount).toBe(1);
    const saved = await repo.load("p1");
    expect(saved?.scenes[0]?.tracks.main.elements.length).toBeGreaterThanOrEqual(1);
  });
  it("previews and playback never trigger saves", async () => {
    const { editor, repo } = setup();
    edit(editor, "c1");
    await vi.advanceTimersByTimeAsync(900);
    const count = repo.saveCount;
    editor.playback.seek(sec(1));
    await vi.advanceTimersByTimeAsync(2000);
    expect(repo.saveCount).toBe(count);
  });
  it("a failed save keeps the project dirty and retries with backoff", async () => {
    const { editor, repo, manager } = setup();
    repo.failNextSaves = 2;
    edit(editor, "c1");
    await vi.advanceTimersByTimeAsync(800);
    expect(manager.getState().status).toBe("error");
    expect(manager.isDirty).toBe(true);
    await vi.advanceTimersByTimeAsync(1000);
    expect(manager.getState().status).toBe("error");
    await vi.advanceTimersByTimeAsync(2000);
    expect(manager.getState().status).toBe("idle");
    expect(repo.saveCount).toBe(1);
    expect(manager.getState().error).toBeNull();
  });
  it("pause suppresses saving until resume; flush saves immediately", async () => {
    const { editor, repo, manager } = setup();
    manager.pause();
    edit(editor, "c1");
    await vi.advanceTimersByTimeAsync(2000);
    expect(repo.saveCount).toBe(0);
    manager.resume();
    manager.markDirty();
    await manager.flush();
    expect(repo.saveCount).toBe(1);
  });
  it("edits made during a save are saved afterwards", async () => {
    const { editor, repo } = setup();
    edit(editor, "c1");
    await vi.advanceTimersByTimeAsync(800);
    edit(editor, "c2");
    await vi.advanceTimersByTimeAsync(800);
    expect(repo.saveCount).toBe(2);
    const loaded = await repo.load("p1");
    expect(allElements(loaded!.scenes[0]!.tracks)).toHaveLength(2);
  });
  it("does not save when no project is open", async () => {
    const { editor, repo, manager } = setup();
    editor.close();
    manager.markDirty();
    await vi.advanceTimersByTimeAsync(2000);
    expect(repo.saveCount).toBe(0);
  });
});
