import { createProject, type IdGenerator, type MediaAssetInfo, type Project, type ProjectMetadata } from "#/engine/model";
import { allElements } from "#/engine/timeline";
import { ProjectChangedError, ProjectLockedError, type AssetRepository, type ProjectLibrary, type DerivedDataPurger, type ProjectLocks, type ProjectRepository } from "./types";

export type ProjectSortKey = "createdAt" | "updatedAt" | "name" | "duration";
export type SortOrder = "asc" | "desc";

export function sortProjects(projects: ReadonlyArray<ProjectMetadata>, key: ProjectSortKey, order: SortOrder): ProjectMetadata[] {
  const dir = order === "asc" ? 1 : -1;
  return [...projects].sort((a, b) => {
    const cmp = key === "name" ? a.name.localeCompare(b.name, undefined, { sensitivity: "base" })
      : key === "duration" ? a.duration - b.duration
      : a[key].localeCompare(b[key]);
    return cmp * dir;
  });
}

export function filterProjects(projects: ReadonlyArray<ProjectMetadata>, query: string): ProjectMetadata[] {
  const q = query.trim().toLowerCase();
  return q ? projects.filter((p) => p.name.toLowerCase().includes(q)) : [...projects];
}

/** "(2) Holiday" -> base "Holiday". Duplicates are named "(N) base" where N is one more than any existing copy. */
export function duplicateName(name: string, existing: ReadonlyArray<string>): string {
  const strip = (n: string): { base: string; n: number } => {
    const m = /^\((\d+)\)\s+(.+)$/.exec(n);
    return m ? { base: m[2] as string, n: Number(m[1]) } : { base: n, n: 0 };
  };
  const { base } = strip(name);
  const highest = existing.reduce((max, n) => {
    const s = strip(n);
    return s.base === base ? Math.max(max, s.n) : max;
  }, 0);
  return `(${highest + 1}) ${base}`;
}

export class ProjectsService {
  constructor(private readonly deps: {
    projects: ProjectRepository; assets: AssetRepository; newId: IdGenerator; now: () => string; locks?: ProjectLocks;
    /** Derived data (analysis, transcripts, embeddings, faces) is deleted together with the last copy of an asset's bytes. */
    derived?: DerivedDataPurger;
  }) {}

  list(): Promise<ProjectMetadata[]> {
    return this.deps.projects.list();
  }

  async create(name: string): Promise<Project> {
    const project = createProject({ id: this.deps.newId(), name, ids: this.deps.newId, now: this.deps.now() });
    await this.deps.projects.save(project);
    return project;
  }

  /** Readable projects plus rows that could not be read, so the library never hides stored data. */
  listLibrary(): Promise<ProjectLibrary> {
    return this.deps.projects.listLibrary();
  }

  /** The stored text of a project row, for saving a copy of data this version cannot open. */
  loadRaw(id: string): Promise<string | null> {
    return this.deps.projects.loadRaw(id);
  }

  /**
   * Runs `work` while holding the project's cross-tab lock. The tab that has a project open owns the lock for its
   * whole session and autosaves over the row, so any other writer would be reverted or would revert it.
   */
  private async withProjectLock<T>(id: string, work: () => Promise<T>): Promise<T> {
    const lock = await this.deps.locks?.tryAcquire(id);
    if (lock === null) throw new ProjectLockedError(id);
    try {
      return await work();
    } finally {
      lock?.release();
    }
  }

  /** Refuses (ProjectLockedError) while another tab has the project open. The write is also compare-and-set on `updatedAt`, so a stale copy can never replace newer edits even where Web Locks are unavailable. */
  async rename(id: string, name: string): Promise<void> {
    await this.withProjectLock(id, async () => {
      const project = await this.deps.projects.load(id);
      if (!project) throw new Error(`Project ${id} not found`);
      const renamed = { ...project, metadata: { ...project.metadata, name, updatedAt: this.deps.now() } };
      if (!(await this.deps.projects.saveIfUnchanged(renamed, project.metadata.updatedAt))) throw new ProjectChangedError(id);
    });
  }

  async duplicate(ids: ReadonlyArray<string>): Promise<string[]> {
    const existing = (await this.deps.projects.list()).map((p) => p.name);
    const created: string[] = [];
    for (const id of new Set(ids)) {
      const copyId = await this.withProjectLock(id, async () => {
        const source = await this.deps.projects.load(id);
        if (!source) throw new Error(`Project ${id} not found`);
        const now = this.deps.now();
        const name = duplicateName(source.metadata.name, existing);
        existing.push(name);
        const copy: Project = { ...source, metadata: { ...source.metadata, id: this.deps.newId(), name, createdAt: now, updatedAt: now } };
        try {
          await this.deps.assets.copyAll(id, copy.metadata.id);
          await this.deps.projects.save(copy);
        } catch (error) {
          await this.deps.assets.removeAll(copy.metadata.id).catch(() => undefined);
          throw error;
        }
        return copy.metadata.id;
      });
      created.push(copyId);
    }
    return created;
  }

  /** Removes the project row first so a failure never leaves a listed project whose media is gone. */
  async delete(ids: ReadonlyArray<string>): Promise<void> {
    for (const id of ids) {
      const lock = await this.deps.locks?.tryAcquire(id);
      if (lock === null) throw new ProjectLockedError(id);
      try {
        const held = (await this.deps.assets.list(id)).map((a) => a.id);
        await this.deps.projects.delete(id);
        await this.deps.assets.removeAll(id);
        await this.purgeUnreferenced(held);
      } finally {
        lock?.release();
      }
    }
  }

  /**
   * Duplicated projects share asset ids, so derived data is deleted only when no project still stores the asset's bytes.
   * Failing to purge never fails the caller (the bytes are already gone); `purgeStrayDerived` catches up later.
   */
  private async purgeUnreferenced(assetIds: ReadonlyArray<string>): Promise<void> {
    const derived = this.deps.derived;
    if (!derived || assetIds.length === 0) return;
    try {
      const held = await this.heldAssetIds();
      const doomed = assetIds.filter((id) => !held.has(id));
      if (doomed.length > 0) await derived.purgeAssets(doomed);
    } catch (error) {
      console.warn("Could not remove derived data of deleted media", error);
    }
  }

  private async heldAssetIds(): Promise<Set<string>> {
    return new Set(await this.deps.assets.listAllIds());
  }

  /** Deletes derived data whose asset no project stores any more: leftovers of failed purges, or of finishing jobs for removed media. */
  async purgeStrayDerived(): Promise<string[]> {
    const derived = this.deps.derived;
    if (!derived) return [];
    const held = await this.heldAssetIds();
    const stray = (await derived.listAssetIds()).filter((id) => !held.has(id));
    if (stray.length > 0) await derived.purgeAssets(stray);
    return stray;
  }

  /** Opens a project's media: only assets the project lists, in project order. */
  async loadAssets(project: Project): Promise<MediaAssetInfo[]> {
    const stored = new Map((await this.deps.assets.list(project.metadata.id)).map((a) => [a.id, a]));
    return project.assetIds.map((id) => stored.get(id)).filter((a): a is MediaAssetInfo => a !== undefined);
  }

  /** Deletes stored media the saved project no longer lists (left behind by removals that stayed undoable). */
  async collectOrphans(project: Project): Promise<void> {
    const keep = new Set(project.assetIds);
    const removed: string[] = [];
    for (const info of await this.deps.assets.list(project.metadata.id)) {
      if (keep.has(info.id)) continue;
      await this.deps.assets.remove(project.metadata.id, info.id);
      removed.push(info.id);
    }
    await this.purgeUnreferenced(removed);
  }

  /**
   * The last step of closing a project. The saved row still lists media that only undo history kept alive (removed
   * assets stay in `assetIds` while they can be restored); history ends with the session, so those ids are dropped here
   * and their bytes, and the data derived from them, are swept. Run only after the final save succeeded.
   */
  async finalizeClose(input: { projectId: string; registeredAssetIds: ReadonlyArray<string> }): Promise<void> {
    const persisted = await this.deps.projects.load(input.projectId);
    if (!persisted) return;
    const live = new Set(input.registeredAssetIds);
    for (const scene of persisted.scenes) {
      for (const { element } of allElements(scene.tracks)) if ("mediaId" in element) live.add(element.mediaId);
    }
    const assetIds = persisted.assetIds.filter((id) => live.has(id));
    if (assetIds.length !== persisted.assetIds.length) await this.deps.projects.save({ ...persisted, assetIds });
    await this.sweepOrphans(input.projectId);
  }

  /** Sweeps against the row that is actually in storage, never an in-memory copy that may be stale. */
  async sweepOrphans(projectId: string): Promise<void> {
    const persisted = await this.deps.projects.load(projectId);
    if (persisted) await this.collectOrphans(persisted);
  }
}
