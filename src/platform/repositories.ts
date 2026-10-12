import type { MediaAssetInfo, Project, ProjectMetadata } from "#/engine/model";
import {
  StorageQuotaError, describeUnreadable, deserializeProject, isQuotaExceededError, serializeProject,
  type AssetRepository, type ProjectLibrary, type ProjectRepository, type StoredAsset,
} from "#/engine/persistence";
import { CURRENT } from "./legacy-migration";
import { openDatabase, KeyValueStore, prefixRange } from "./idb";
import type { FileStore } from "./file-store";

const DB_NAME = CURRENT.dbName;
const DB_VERSION = 1;

export interface Database {
  projects: KeyValueStore<{ id: string; json: string }>;
  assets: KeyValueStore<{ key: string; projectId: string; info: MediaAssetInfo }>;
  blobs: KeyValueStore<Blob>;
}

export function openAppDatabase(factory?: IDBFactory): Database {
  const dbPromise = openDatabase({
    name: DB_NAME, version: DB_VERSION, factory,
    stores: [{ name: "projects", keyPath: "id" }, { name: "assets", keyPath: "key" }, { name: "blobs" }],
  });
  return {
    projects: new KeyValueStore(dbPromise, "projects"),
    assets: new KeyValueStore(dbPromise, "assets"),
    blobs: new KeyValueStore(dbPromise, "blobs"),
  };
}

export class IdbProjectRepository implements ProjectRepository {
  constructor(private readonly db: Database) {}

  async list(): Promise<ProjectMetadata[]> {
    return (await this.listLibrary()).projects;
  }

  async listLibrary(): Promise<ProjectLibrary> {
    const rows = await this.db.projects.getAll();
    const projects: ProjectMetadata[] = [];
    const unreadable: ProjectLibrary["unreadable"] = [];
    for (const row of rows) {
      try {
        projects.push(deserializeProject(row.json).metadata);
      } catch (error) {
        unreadable.push(describeUnreadable(row.id, typeof row.json === "string" ? row.json : "", error));
      }
    }
    return { projects: projects.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)), unreadable };
  }

  async loadRaw(id: string): Promise<string | null> {
    const row = await this.db.projects.get(id);
    return row ? (typeof row.json === "string" ? row.json : JSON.stringify(row)) : null;
  }

  async load(id: string): Promise<Project | null> {
    const row = await this.db.projects.get(id);
    return row ? deserializeProject(row.json) : null;
  }

  async save(project: Project): Promise<void> {
    await this.db.projects.put({ id: project.metadata.id, json: serializeProject(project) });
  }

  async saveIfUnchanged(project: Project, expectedUpdatedAt: string): Promise<boolean> {
    return this.db.projects.update(project.metadata.id, (row) => {
      if (!row) return undefined;
      try {
        if (deserializeProject(row.json).metadata.updatedAt !== expectedUpdatedAt) return undefined;
      } catch {
        return undefined;
      }
      return { id: project.metadata.id, json: serializeProject(project) };
    });
  }

  async delete(id: string): Promise<void> {
    await this.db.projects.delete(id);
  }
}

export class IdbAssetRepository implements AssetRepository {
  constructor(private readonly db: Database, private readonly files: FileStore | null) {}

  private key(projectId: string, assetId: string): string {
    return `${projectId}/${assetId}`;
  }

  async list(projectId: string): Promise<MediaAssetInfo[]> {
    const rows = await this.db.assets.getAllInRange(prefixRange(`${projectId}/`));
    return rows.map((r) => r.info);
  }

  async listAllIds(): Promise<string[]> {
    return [...new Set((await this.db.assets.getAll()).map((r) => r.info.id))];
  }

  /** Bytes first, metadata second: a failure never leaves metadata pointing at missing bytes. */
  async save(projectId: string, asset: StoredAsset): Promise<void> {
    const key = this.key(projectId, asset.info.id);
    try {
      if (this.files) await this.files.put(key, asset.file);
      else await this.db.blobs.put(asset.file, key);
      await this.db.assets.put({ key, projectId, info: asset.info });
    } catch (error) {
      await this.removeBytes(key).catch(() => undefined);
      if (isQuotaExceededError(error)) throw new StorageQuotaError();
      throw error;
    }
  }

  private async removeBytes(key: string): Promise<void> {
    if (this.files) await this.files.delete(key);
    else await this.db.blobs.delete(key);
  }

  async getFile(projectId: string, assetId: string): Promise<Blob | null> {
    const key = this.key(projectId, assetId);
    if (this.files) return this.files.get(key);
    return (await this.db.blobs.get(key)) ?? null;
  }

  async remove(projectId: string, assetId: string): Promise<void> {
    const key = this.key(projectId, assetId);
    await this.removeBytes(key);
    await this.db.assets.delete(key);
  }

  async removeAll(projectId: string): Promise<void> {
    const prefix = `${projectId}/`;
    if (this.files) await this.files.deletePrefix(prefix);
    else await this.db.blobs.deleteRange(prefixRange(prefix));
    await this.db.assets.deleteRange(prefixRange(prefix));
  }

  async copyAll(fromProjectId: string, toProjectId: string): Promise<void> {
    for (const info of await this.list(fromProjectId)) {
      const file = await this.getFile(fromProjectId, info.id);
      if (file) await this.save(toProjectId, { info, file });
    }
  }
}
