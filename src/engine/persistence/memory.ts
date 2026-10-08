import type { MediaAssetInfo, Project, ProjectMetadata } from "#/engine/model";
import { deserializeProject, serializeProject } from "./serialization";
import type { AssetRepository, ProjectRepository, StoredAsset } from "./types";

/** In-memory repositories for tests and as a no-storage fallback. Projects round-trip through JSON like real storage. */
export class MemoryProjectRepository implements ProjectRepository {
  private readonly records = new Map<string, string>();
  saveCount = 0;
  failNextSaves = 0;

  async list(): Promise<ProjectMetadata[]> {
    return [...this.records.values()].map((json) => deserializeProject(json).metadata)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  async load(id: string): Promise<Project | null> {
    const json = this.records.get(id);
    return json ? deserializeProject(json) : null;
  }
  async save(project: Project): Promise<void> {
    if (this.failNextSaves > 0) {
      this.failNextSaves--;
      throw new Error("storage unavailable");
    }
    this.saveCount++;
    this.records.set(project.metadata.id, serializeProject(project));
  }
  async delete(id: string): Promise<void> {
    this.records.delete(id);
  }
}

export class MemoryAssetRepository implements AssetRepository {
  private readonly projects = new Map<string, Map<string, StoredAsset>>();

  private bucket(projectId: string): Map<string, StoredAsset> {
    let b = this.projects.get(projectId);
    if (!b) {
      b = new Map();
      this.projects.set(projectId, b);
    }
    return b;
  }
  async list(projectId: string): Promise<MediaAssetInfo[]> {
    return [...this.bucket(projectId).values()].map((a) => a.info);
  }
  async save(projectId: string, asset: StoredAsset): Promise<void> {
    this.bucket(projectId).set(asset.info.id, asset);
  }
  async getFile(projectId: string, assetId: string): Promise<Blob | null> {
    return this.bucket(projectId).get(assetId)?.file ?? null;
  }
  async remove(projectId: string, assetId: string): Promise<void> {
    this.bucket(projectId).delete(assetId);
  }
  async removeAll(projectId: string): Promise<void> {
    this.projects.delete(projectId);
  }
  async copyAll(from: string, to: string): Promise<void> {
    for (const asset of this.bucket(from).values()) this.bucket(to).set(asset.info.id, asset);
  }
}
