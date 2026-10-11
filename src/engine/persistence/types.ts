import type { MediaAssetInfo, Project, ProjectMetadata } from "#/engine/model";

export interface ProjectRepository {
  list(): Promise<ProjectMetadata[]>;
  load(id: string): Promise<Project | null>;
  save(project: Project): Promise<void>;
  delete(id: string): Promise<void>;
}

export interface StoredAsset {
  info: MediaAssetInfo;
  file: Blob;
}

/** Bytes and metadata for a project's media, kept apart from the project document. */
export interface AssetRepository {
  list(projectId: string): Promise<MediaAssetInfo[]>;
  /** Ids of every asset whose bytes are stored for any project, readable or not. */
  listAllIds(): Promise<string[]>;
  save(projectId: string, asset: StoredAsset): Promise<void>;
  getFile(projectId: string, assetId: string): Promise<Blob | null>;
  remove(projectId: string, assetId: string): Promise<void>;
  removeAll(projectId: string): Promise<void>;
  copyAll(fromProjectId: string, toProjectId: string): Promise<void>;
}

export class StorageQuotaError extends Error {
  constructor(message = "Not enough storage space for this file") {
    super(message);
    this.name = "StorageQuotaError";
  }
}

export class ProjectFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProjectFormatError";
  }
}

export interface ProjectLockHandle {
  release(): void;
}

/** Exclusive, cross-tab ownership of a project. `tryAcquire` resolves null when another holder has it. */
export interface ProjectLocks {
  tryAcquire(projectId: string): Promise<ProjectLockHandle | null>;
}

export class ProjectLockedError extends Error {
  constructor(readonly projectId: string) {
    super("This project is open in another tab");
    this.name = "ProjectLockedError";
  }
}

export class SaveFailedError extends Error {
  constructor(detail: string) {
    super(`Your latest changes could not be saved: ${detail}`);
    this.name = "SaveFailedError";
  }
}

/** Per-asset data derived from media bytes (analysis, transcripts, embeddings, faces) that must die with the bytes. */
export interface DerivedDataPurger {
  /** Deletes everything derived from these assets in every store. Resolves once all stores were tried; rejects if any failed. */
  purgeAssets(assetIds: ReadonlyArray<string>): Promise<void>;
  /** Asset ids that have derived data in at least one store. */
  listAssetIds(): Promise<string[]>;
}
