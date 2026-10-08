import { createProject, type IdGenerator, type MediaAssetInfo, type Project, type ProjectMetadata } from "#/engine/model";
import type { AssetRepository, ProjectRepository } from "./types";

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
    projects: ProjectRepository; assets: AssetRepository; newId: IdGenerator; now: () => string;
  }) {}

  list(): Promise<ProjectMetadata[]> {
    return this.deps.projects.list();
  }

  async create(name: string): Promise<Project> {
    const project = createProject({ id: this.deps.newId(), name, ids: this.deps.newId, now: this.deps.now() });
    await this.deps.projects.save(project);
    return project;
  }

  async rename(id: string, name: string): Promise<void> {
    const project = await this.deps.projects.load(id);
    if (!project) throw new Error(`Project ${id} not found`);
    await this.deps.projects.save({ ...project, metadata: { ...project.metadata, name, updatedAt: this.deps.now() } });
  }

  async duplicate(ids: ReadonlyArray<string>): Promise<string[]> {
    const existing = (await this.deps.projects.list()).map((p) => p.name);
    const created: string[] = [];
    for (const id of new Set(ids)) {
      const source = await this.deps.projects.load(id);
      if (!source) throw new Error(`Project ${id} not found`);
      const now = this.deps.now();
      const name = duplicateName(source.metadata.name, existing);
      existing.push(name);
      const copy: Project = { ...source, metadata: { ...source.metadata, id: this.deps.newId(), name, createdAt: now, updatedAt: now } };
      await this.deps.projects.save(copy);
      await this.deps.assets.copyAll(id, copy.metadata.id);
      created.push(copy.metadata.id);
    }
    return created;
  }

  async delete(ids: ReadonlyArray<string>): Promise<void> {
    for (const id of ids) {
      await this.deps.assets.removeAll(id);
      await this.deps.projects.delete(id);
    }
  }

  /** Opens a project's media: only assets the project lists, in project order. */
  async loadAssets(project: Project): Promise<MediaAssetInfo[]> {
    const stored = new Map((await this.deps.assets.list(project.metadata.id)).map((a) => [a.id, a]));
    return project.assetIds.map((id) => stored.get(id)).filter((a): a is MediaAssetInfo => a !== undefined);
  }

  /** Deletes stored media the saved project no longer lists (left behind by removals that stayed undoable). */
  async collectOrphans(project: Project): Promise<void> {
    const keep = new Set(project.assetIds);
    for (const info of await this.deps.assets.list(project.metadata.id)) {
      if (!keep.has(info.id)) await this.deps.assets.remove(project.metadata.id, info.id);
    }
  }
}
