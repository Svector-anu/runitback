import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it, vi } from "vitest";
import { AppServices, type AppServicesDeps } from "#/app/services";
import { callTool, createAgentTools, createFaceTools, createTemporalTools, createTranscriptTools, createVisualTools, type AgentToolRegistry } from "#/engine/agent";
import { MemoryAssetRepository, MemoryProjectRepository, ProjectsService } from "#/engine/persistence";
import { createProject, sequentialIds, type MediaAssetInfo } from "#/engine/model";
import { IdbAnalysisStore, analysisCacheKey } from "#/platform/analysis";
import { DerivedDataRegistry } from "#/platform/derived-data";
import { analysisAdapter, faceAdapter, transcriptAdapter, visualAdapter } from "#/platform/derived-data-adapters";
import { MediaRuntime } from "#/platform/media-runtime";
import { IdbTranscriptStore } from "#/platform/transcribe";
import { IdbFaceStore, IdbVisualStore } from "#/platform/visual";
import { A1_FACE_FRAMES, detections } from "./face-harness";
import { makeEditor, videoAsset } from "./helpers";
import { makeAnalysis } from "./temporal-harness";
import { TALK_WORDS, transcriptOf } from "./transcript-harness";
import { A1_CUTS, A1_FRAMES, fakeSearcher, makeEmbeddings } from "./visual-harness";

interface World {
  services: AppServices;
  projects: MemoryProjectRepository;
  assets: MemoryAssetRepository;
  derived: DerivedDataRegistry;
  stores: { analysis: IdbAnalysisStore; transcripts: IdbTranscriptStore; visual: IdbVisualStore; faces: IdbFaceStore };
}

function world(): World {
  const factory = new IDBFactory();
  const stores = { analysis: new IdbAnalysisStore(factory), transcripts: new IdbTranscriptStore(factory), visual: new IdbVisualStore(factory), faces: new IdbFaceStore(factory) };
  const derived = new DerivedDataRegistry()
    .register(analysisAdapter(stores.analysis)).register(transcriptAdapter(stores.transcripts)).register(visualAdapter(stores.visual)).register(faceAdapter(stores.faces));
  const projects = new MemoryProjectRepository();
  const assets = new MemoryAssetRepository();
  const deps: AppServicesDeps = {
    projectRepository: projects, assetRepository: assets, locks: { tryAcquire: async () => ({ release: () => undefined }) },
    storageMode: "indexeddb", derivedData: derived, createRuntime: () => new MediaRuntime(),
    createAudioEngine: () => ({ attach: () => undefined, restart: () => undefined, dispose: () => undefined }),
    probe: vi.fn(async (file: File, id: string): Promise<MediaAssetInfo> => ({ ...videoAsset(id), name: file.name })),
  };
  return { services: new AppServices(deps), projects, assets, derived, stores };
}

async function seed(w: World, info: MediaAssetInfo): Promise<void> {
  await w.stores.analysis.put(analysisCacheKey(info), makeAnalysis({ assetId: info.id, cuts: A1_CUTS }));
  await w.stores.transcripts.save(transcriptOf(info.id, TALK_WORDS));
  await w.stores.visual.save(makeEmbeddings({ assetId: info.id, frames: A1_FRAMES, cuts: A1_CUTS }));
  await w.stores.faces.save(detections({ assetId: info.id, frames: A1_FACE_FRAMES }));
}

async function projectWithAsset(w: World, name = "P"): Promise<{ projectId: string; asset: MediaAssetInfo }> {
  const project = await w.services.projects.create(name);
  await w.services.openProject(project.metadata.id);
  const outcome = await w.services.importFiles([new File([new Uint8Array(8)], "clip.mp4", { type: "video/mp4" })]);
  const asset = outcome.imported[0]!;
  await seed(w, asset);
  return { projectId: project.metadata.id, asset };
}

const hasDerived = async (w: World, id: string): Promise<boolean> => (await w.derived.listAssetIds()).includes(id);

describe("derived data follows the bytes", () => {
  it("keeps it while a removal can still be undone, and after undo and close", async () => {
    const w = world();
    const { projectId, asset } = await projectWithAsset(w);
    expect(w.services.removeAssets([asset.id]).ok).toBe(true);
    expect(await hasDerived(w, asset.id)).toBe(true);
    expect(w.services.editor.undo()).toBe(true);
    await w.services.closeProject();
    expect(await w.assets.getFile(projectId, asset.id)).not.toBeNull();
    expect(await hasDerived(w, asset.id)).toBe(true);
  });

  it("purges it when the bytes are swept after a clean close", async () => {
    const w = world();
    const { projectId, asset } = await projectWithAsset(w);
    expect(w.services.removeAssets([asset.id]).ok).toBe(true);
    expect(await hasDerived(w, asset.id)).toBe(true);
    await w.services.closeProject();
    expect(await w.assets.getFile(projectId, asset.id)).toBeNull();
    expect(await hasDerived(w, asset.id)).toBe(false);
    expect(await w.stores.transcripts.get(asset.id)).toBeUndefined();
    await w.services.openProject(projectId);
    expect(w.services.editor.getState().doc.assets).toEqual([]);
  });

  it("purges it when the project is deleted", async () => {
    const w = world();
    const { projectId, asset } = await projectWithAsset(w);
    await w.services.closeProject();
    expect(await hasDerived(w, asset.id)).toBe(true);
    await w.services.projects.delete([projectId]);
    expect(await hasDerived(w, asset.id)).toBe(false);
  });

  it("keeps it while a duplicate of the project still stores the asset, and purges it with the last copy", async () => {
    const w = world();
    const { projectId, asset } = await projectWithAsset(w);
    await w.services.closeProject();
    const [copyId] = await w.services.projects.duplicate([projectId]);
    await w.services.projects.delete([projectId]);
    expect(await hasDerived(w, asset.id)).toBe(true);
    await w.services.projects.delete([copyId!]);
    expect(await hasDerived(w, asset.id)).toBe(false);
  });

  it("does not touch other assets", async () => {
    const w = world();
    const first = await projectWithAsset(w, "one");
    await w.services.closeProject();
    const second = await projectWithAsset(w, "two");
    await w.services.closeProject();
    await w.services.projects.delete([first.projectId]);
    expect(await hasDerived(w, first.asset.id)).toBe(false);
    expect(await hasDerived(w, second.asset.id)).toBe(true);
  });

  it("still deletes the project when purging fails, and the stray sweep finishes the job later", async () => {
    const w = world();
    const { projectId, asset } = await projectWithAsset(w);
    await w.services.closeProject();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const purge = vi.spyOn(w.derived, "purgeAssets").mockRejectedValueOnce(new Error("idb gone"));
    await w.services.projects.delete([projectId]);
    expect(warn).toHaveBeenCalled();
    expect(purge).toHaveBeenCalled();
    expect(await w.projects.list()).toEqual([]);
    expect(await hasDerived(w, asset.id)).toBe(true);
    expect(await w.services.purgeStrayDerivedData()).toEqual([asset.id]);
    expect(await hasDerived(w, asset.id)).toBe(false);
    warn.mockRestore();
  });

  it("the stray sweep never deletes data of an asset whose bytes exist, even in an unreadable project", async () => {
    const w = world();
    const { projectId, asset } = await projectWithAsset(w);
    await w.services.closeProject();
    const project = (await w.projects.load(projectId))!;
    await w.projects.save({ ...project, version: 999 });
    expect(await w.services.purgeStrayDerivedData()).toEqual([]);
    expect(await hasDerived(w, asset.id)).toBe(true);
  });

  it("ProjectsService without a purger behaves as before", async () => {
    const projects = new MemoryProjectRepository();
    const assets = new MemoryAssetRepository();
    const service = new ProjectsService({ projects, assets, newId: sequentialIds("n"), now: () => "t" });
    const project = createProject({ id: "p", name: "p", ids: sequentialIds("i"), now: "t" });
    await projects.save(project);
    await assets.save("p", { info: videoAsset("x"), file: new Blob(["x"]) });
    await service.sweepOrphans("p");
    expect(await assets.list("p")).toEqual([]);
    expect(await service.purgeStrayDerived()).toEqual([]);
  });
});

describe("the agent cannot find moments of a deleted asset", () => {
  async function agentTools(w: World, asset: MediaAssetInfo): Promise<{ call: (name: string, args: unknown) => ReturnType<typeof callTool>; tools: AgentToolRegistry }> {
    const { editor } = makeEditor({ assets: [asset] });
    const tools = new Map(createAgentTools());
    const analysis = { get: async (id: string) => (id === asset.id ? w.stores.analysis.get(analysisCacheKey(asset)) : undefined) };
    for (const tool of createTemporalTools({ analysis, transcripts: w.stores.transcripts })) tools.set(tool.name, tool);
    for (const tool of createTranscriptTools({ store: w.stores.transcripts })) tools.set(tool.name, tool);
    for (const tool of createVisualTools({ store: w.stores.visual, searcher: fakeSearcher() })) tools.set(tool.name, tool);
    for (const tool of createFaceTools({ faces: w.stores.faces, analysis })) tools.set(tool.name, tool);
    const ctx = { editor, nowMs: () => 0 };
    return { tools, call: (name, args) => callTool({ tools, name, args, ctx }) };
  }

  it("find_moments, find_visual_moments, find_face_moments and get_transcript return data before and none after the purge", async () => {
    const w = world();
    const { asset } = await projectWithAsset(w);
    const { call } = await agentTools(w, { ...asset, id: asset.id });
    const queries: Array<[string, unknown]> = [
      ["find_moments", { assetId: asset.id, speaking: true }],
      ["find_visual_moments", { assetId: asset.id, query: "dog" }],
      ["find_face_moments", { assetId: asset.id }],
      ["get_transcript", { assetId: asset.id }],
    ];
    for (const [name, args] of queries) {
      const before = await call(name, args);
      expect(before.ok, `${name} before`).toBe(true);
    }
    await w.derived.purgeAssets([asset.id]);
    for (const [name, args] of queries) {
      const after = await call(name, args);
      const moments = after.ok ? (after.data as { moments?: unknown[]; sentences?: unknown[] }) : null;
      const empty = !after.ok || (moments?.moments ?? moments?.sentences ?? []).length === 0;
      expect(empty, `${name} after purge: ${JSON.stringify(after).slice(0, 200)}`).toBe(true);
    }
  });
});
