import type { IdGenerator, MediaAssetInfo, Project } from "#/engine/model";
import {
  BUNDLE_EXTENSION, BUNDLE_LIMITS, BundleError, DERIVED_KINDS, MANIFEST_PATH, ProjectFormatError, StorageQuotaError, assetPath, buildManifest,
  canStoreFile, declaredBundleBytes, deserializeProject, derivedPath, duplicateName, findResidualIds, parseManifest, remapProjectIds, serializeProject,
  verifyArchiveAgainstManifest, type AssetRepository, type BundleManifest, type DerivedKind, type ProjectRepository,
} from "#/engine/persistence";
import { documentViolations } from "#/engine/timeline";
import { digestBlob, sha256OfBytes } from "./bundle-hash";
import { ZipArchive, ZipWriter } from "./bundle-zip";
import type { DerivedDataRegistry } from "./derived-data";
import { estimateStorage, type StorageManagerLike } from "./file-store";

export type BundlePhase = "reading" | "packing" | "verifying" | "importing";

export interface BundleProgress {
  phase: BundlePhase;
  /** Bytes processed in this phase. */
  done: number;
  total: number;
  label?: string;
}

interface BundleCommon {
  onProgress?: (progress: BundleProgress) => void;
  signal?: AbortSignal;
}

const encoder = new TextEncoder();

export class BundleProjectNotFoundError extends Error {
  constructor(id: string) {
    super(`Project ${id} was not found`);
    this.name = "BundleProjectNotFoundError";
  }
}

export interface ExportBundleDeps {
  projects: ProjectRepository;
  assets: AssetRepository;
  derived: DerivedDataRegistry;
  now: () => string;
  createdWith: string;
}

export interface ExportBundleResult {
  blob: Blob;
  fileName: string;
  manifest: BundleManifest;
  /** Media the project lists but whose bytes were not in storage; they are not in the bundle. */
  missingAssets: string[];
}

export function bundleFileName(projectName: string): string {
  const base = projectName.replace(/[^\p{L}\p{N}._ -]+/gu, "").replace(/^[.\s]+/, "").trim().replace(/\s+/g, "-").slice(0, 80);
  return `${base || "project"}${BUNDLE_EXTENSION}`;
}

/**
 * Packs a stored project into one `.runitback` file. Media is hashed in one streaming pass and then referenced, not
 * copied: the returned blob is a view over the stored files plus the (small, deflated) JSON entries.
 */
export async function exportProjectBundle(
  deps: ExportBundleDeps, input: BundleCommon & { projectId: string; includeEmbeddings: boolean },
): Promise<ExportBundleResult> {
  const { signal, onProgress } = input;
  const project = await deps.projects.load(input.projectId);
  if (!project) throw new BundleProjectNotFoundError(input.projectId);
  const listed = new Set(project.assetIds);
  const infos = (await deps.assets.list(input.projectId)).filter((info) => listed.has(info.id));
  const total = infos.reduce((sum, info) => sum + info.size, 0);
  let done = 0;

  const media: Array<{ info: MediaAssetInfo; file: Blob; size: number; sha256: string; crc32: number }> = [];
  const missingAssets: string[] = [];
  for (const info of infos) {
    signal?.throwIfAborted();
    const file = await deps.assets.getFile(input.projectId, info.id);
    if (!file) {
      missingAssets.push(info.id);
      continue;
    }
    const before = done;
    const digest = await digestBlob(file, {
      ...(signal ? { signal } : {}),
      onBytes: (n) => {
        done += n;
        onProgress?.({ phase: "reading", done, total, label: info.name });
      },
    });
    done = before + digest.size;
    media.push({ info, file, ...digest });
  }

  const derivedEntries: Array<{ kind: DerivedKind; assetId: string; bytes: Uint8Array; sha256: string }> = [];
  for (const { info } of media) {
    for (const store of deps.derived.stores) {
      signal?.throwIfAborted();
      const payload = await store.exportAsset(info, { includeEmbeddings: input.includeEmbeddings });
      if (payload === undefined) continue;
      const bytes = encoder.encode(JSON.stringify(payload));
      if (bytes.length > BUNDLE_LIMITS.maxDerivedEntryBytes) continue;
      derivedEntries.push({ kind: store.kind, assetId: info.id, bytes, sha256: sha256OfBytes(bytes) });
    }
  }

  const projectBytes = encoder.encode(serializeProject(project));
  if (projectBytes.length > BUNDLE_LIMITS.maxProjectBytes) throw new BundleError("too-large", "The project document is too large to export");
  const manifest = buildManifest({
    project,
    projectEntry: { size: projectBytes.length, sha256: sha256OfBytes(projectBytes) },
    assets: media.map((m) => ({ info: m.info, size: m.size, sha256: m.sha256 })),
    derived: derivedEntries.map((d) => ({ kind: d.kind, assetId: d.assetId, size: d.bytes.length, sha256: d.sha256 })),
    createdAt: deps.now(),
    createdWith: deps.createdWith,
  });
  if (declaredBundleBytes(manifest) > BUNDLE_LIMITS.maxBundleBytes) throw new BundleError("too-large", "Project media is over 4 GiB, which a single bundle file cannot hold");

  onProgress?.({ phase: "packing", done: 0, total: 1 });
  const zip = new ZipWriter();
  await zip.addBytes(MANIFEST_PATH, encoder.encode(JSON.stringify(manifest)));
  await zip.addBytes(manifest.project.path, projectBytes);
  for (const m of media) zip.addStored({ name: assetPath(m.info.id), blob: m.file, crc32: m.crc32 });
  for (const d of derivedEntries) await zip.addBytes(derivedPath(d.kind, d.assetId), d.bytes);
  const blob = zip.finish();
  onProgress?.({ phase: "packing", done: 1, total: 1 });
  return { blob, fileName: bundleFileName(project.metadata.name), manifest, missingAssets };
}

export interface ImportBundleDeps {
  projects: ProjectRepository;
  assets: AssetRepository;
  derived: DerivedDataRegistry;
  newId: IdGenerator;
  now: () => string;
  storage?: StorageManagerLike;
}

export interface ImportBundleResult {
  projectId: string;
  name: string;
  assetCount: number;
  derivedImported: number;
  /** Derived entries that were readable but unusable (unknown kind, wrong version, malformed); the project is complete without them. */
  derivedSkipped: number;
  repairNotes: string[];
}

async function readProject(zip: ZipArchive, manifest: BundleManifest): Promise<Project> {
  const bytes = await zip.bytes(manifest.project.path, BUNDLE_LIMITS.maxProjectBytes);
  if (sha256OfBytes(bytes) !== manifest.project.sha256) throw new BundleError("checksum-mismatch", "project.json failed its integrity check");
  try {
    return deserializeProject(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (error) {
    if (error instanceof ProjectFormatError) throw new BundleError(/newer version/.test(error.message) ? "newer-version" : "malformed", error.message);
    throw new BundleError("malformed", "project.json is not a readable project");
  }
}

/**
 * Imports a bundle as a NEW project with fresh ids. Everything is verified (structure, sizes, SHA-256 of every entry)
 * before any byte is stored; the project row is written last, and any failure removes what was stored, so an import
 * either produces a complete openable project or leaves no trace.
 */
export async function importProjectBundle(deps: ImportBundleDeps, file: Blob, input: BundleCommon = {}): Promise<ImportBundleResult> {
  const { signal, onProgress } = input;
  if (file.size > BUNDLE_LIMITS.maxBundleBytes) throw new BundleError("too-large", "This file is too large to be a project bundle");
  const zip = await ZipArchive.open(file);
  const manifest = parseManifest(await zip.json(MANIFEST_PATH, BUNDLE_LIMITS.maxManifestBytes));
  verifyArchiveAgainstManifest(manifest, zip.entries);

  const mediaBytes = manifest.assets.reduce((sum, a) => sum + a.size, 0);
  const estimate = await estimateStorage(deps.storage);
  const decision = canStoreFile({ size: mediaBytes, ...(estimate ?? {}) });
  if (!decision.canStore) throw new StorageQuotaError("Not enough storage space to import this project");

  const parsed = await readProject(zip, manifest);
  const derivedBlobs: Array<{ kind: DerivedKind; assetId: string; payload: unknown }> = [];

  let verified = 0;
  for (const asset of manifest.assets) {
    signal?.throwIfAborted();
    const blob = await zip.blob(asset.path);
    const entry = zip.entries.get(asset.path);
    const digest = await digestBlob(blob, {
      ...(signal ? { signal } : {}),
      onBytes: (n) => {
        verified += n;
        onProgress?.({ phase: "verifying", done: verified, total: mediaBytes, label: asset.info.name });
      },
    });
    if (digest.sha256 !== asset.sha256 || digest.size !== asset.size || (entry && digest.crc32 !== entry.crc32)) {
      throw new BundleError("checksum-mismatch", `${asset.info.name} is damaged (it does not match its checksum)`);
    }
  }
  for (const d of manifest.derived) {
    signal?.throwIfAborted();
    const bytes = await zip.bytes(d.path, BUNDLE_LIMITS.maxDerivedEntryBytes);
    if (sha256OfBytes(bytes) !== d.sha256) throw new BundleError("checksum-mismatch", `${d.path} failed its integrity check`);
    try {
      derivedBlobs.push({ kind: d.kind, assetId: d.assetId, payload: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown });
    } catch {
      throw new BundleError("malformed", `${d.path} is not valid JSON`);
    }
  }

  const oldIds = manifest.assets.map((a) => a.info.id);
  const remapped = remapProjectIds({ project: parsed, assetIds: oldIds, newId: deps.newId });
  const stale = findResidualIds(remapped.project, [...remapped.allIds.keys()]);
  if (stale.length > 0) throw new BundleError("malformed", "Project ids could not be remapped consistently");
  const violations = documentViolations(remapped.project);
  if (violations.length > documentViolations(parsed).length) throw new BundleError("malformed", `Importing would break the project: ${violations[0]}`);

  const newProjectId = remapped.project.metadata.id;
  const existingNames = (await deps.projects.list()).map((p) => p.name);
  const now = deps.now();
  const name = existingNames.includes(remapped.project.metadata.name) ? duplicateName(remapped.project.metadata.name, existingNames) : remapped.project.metadata.name;
  const project: Project = { ...remapped.project, metadata: { ...remapped.project.metadata, name, updatedAt: now } };
  delete project.repairNotes;

  const stored = new Map<string, MediaAssetInfo>();
  try {
    let imported = 0;
    for (const asset of manifest.assets) {
      signal?.throwIfAborted();
      const info: MediaAssetInfo = { ...asset.info, id: remapped.assetIds.get(asset.info.id) as string };
      await deps.assets.save(newProjectId, { info, file: await zip.blob(asset.path) });
      stored.set(asset.info.id, info);
      imported += asset.size;
      onProgress?.({ phase: "importing", done: imported, total: mediaBytes, label: asset.info.name });
    }
    let derivedImported = 0;
    let derivedSkipped = 0;
    for (const entry of derivedBlobs) {
      const info = stored.get(entry.assetId);
      const store = deps.derived.store(entry.kind);
      if (!info || !store || !(DERIVED_KINDS as readonly string[]).includes(entry.kind)) {
        derivedSkipped++;
        continue;
      }
      if (await store.importAsset(info, entry.payload)) derivedImported++;
      else derivedSkipped++;
    }
    signal?.throwIfAborted();
    await deps.projects.save(project);
    return { projectId: newProjectId, name, assetCount: stored.size, derivedImported, derivedSkipped, repairNotes: parsed.repairNotes ?? [] };
  } catch (error) {
    await deps.assets.removeAll(newProjectId).catch(() => undefined);
    await deps.derived.purgeAssets([...stored.values()].map((i) => i.id)).catch(() => undefined);
    throw error;
  }
}
