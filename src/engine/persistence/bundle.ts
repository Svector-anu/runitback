import { PROJECT_SCHEMA_VERSION, type IdGenerator, type MediaAssetInfo, type MediaType, type Project } from "#/engine/model";

/**
 * The `.runitback` portable project format. This module is the pure half: manifest shape, validation, entry naming
 * and id remapping. Zip I/O, hashing of bytes and storage live in the platform layer.
 */
export const BUNDLE_FORMAT = "runitback-bundle";
export const BUNDLE_VERSION = 1;
export const BUNDLE_EXTENSION = ".runitback";
export const BUNDLE_MIME = "application/vnd.runitback.project+zip";
export const MANIFEST_PATH = "manifest.json";
export const PROJECT_PATH = "project.json";

export const DERIVED_KINDS = ["analysis", "transcript", "visual", "faces"] as const;
export type DerivedKind = (typeof DERIVED_KINDS)[number];

const MIB = 1024 * 1024;

/** Hard caps applied before any entry is read, so a hostile manifest cannot make the importer allocate or loop unbounded. */
export const BUNDLE_LIMITS = {
  maxEntries: 20_000,
  maxAssets: 5_000,
  maxManifestBytes: 16 * MIB,
  maxProjectBytes: 64 * MIB,
  maxDerivedEntryBytes: 512 * MIB,
  /** The zip writer emits 32-bit sizes and offsets, so a bundle cannot exceed this. */
  maxBundleBytes: 0xffff_fff0,
  maxIdLength: 128,
  maxJsonDepth: 64,
} as const;

export type BundleErrorCode =
  | "not-a-bundle"
  | "truncated"
  | "malformed"
  | "unsafe-path"
  | "too-large"
  | "newer-version"
  | "unsupported"
  | "missing-entry"
  | "checksum-mismatch";

export class BundleError extends Error {
  constructor(readonly code: BundleErrorCode, message: string) {
    super(message);
    this.name = "BundleError";
  }
}

export interface BundleEntryRef {
  path: string;
  size: number;
  sha256: string;
}

export interface BundleAssetEntry extends BundleEntryRef {
  info: MediaAssetInfo;
}

export interface BundleDerivedEntry extends BundleEntryRef {
  assetId: string;
  kind: DerivedKind;
}

export interface BundleManifest {
  format: typeof BUNDLE_FORMAT;
  bundleVersion: number;
  app: "runitback";
  createdAt: string;
  createdWith: string;
  /** `PROJECT_SCHEMA_VERSION` of the app that wrote `project.json`. */
  schemaVersion: number;
  project: BundleEntryRef & { name: string };
  assets: BundleAssetEntry[];
  derived: BundleDerivedEntry[];
}

const SAFE_ID = /^[A-Za-z0-9_-]+$/;

export function isSafeId(id: unknown): id is string {
  return typeof id === "string" && id.length > 0 && id.length <= BUNDLE_LIMITS.maxIdLength && SAFE_ID.test(id);
}

export function assetPath(assetId: string): string {
  return `media/${assetId}`;
}

export function derivedPath(kind: DerivedKind, assetId: string): string {
  return `derived/${kind}/${assetId}.json`;
}

/** Whether a zip entry name is one this format can contain; everything else (traversal, absolute, odd separators) is hostile. */
export function isAllowedEntryName(name: string): boolean {
  if (name === MANIFEST_PATH || name === PROJECT_PATH) return true;
  const media = /^media\/([^/]+)$/.exec(name);
  if (media) return isSafeId(media[1]);
  const derived = /^derived\/([a-z]+)\/([^/]+)\.json$/.exec(name);
  return derived !== null && (DERIVED_KINDS as readonly string[]).includes(derived[1] as string) && isSafeId(derived[2]);
}

export function assertEntryName(name: string): void {
  if (!isAllowedEntryName(name)) throw new BundleError("unsafe-path", `Bundle contains an unexpected entry name: ${JSON.stringify(name.slice(0, 80))}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function bad(message: string): never {
  throw new BundleError("malformed", `Invalid bundle manifest: ${message}`);
}

function readSize(value: unknown, what: string, max: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) bad(`${what} size must be a non-negative integer`);
  if (value > max) throw new BundleError("too-large", `Bundle entry ${what} declares ${value} bytes, over the ${max} byte limit`);
  return value;
}

function readSha(value: unknown, what: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) bad(`${what} sha256 must be 64 lowercase hex characters`);
  return value;
}

const MEDIA_TYPES: readonly MediaType[] = ["image", "video", "audio"];

function readAssetInfo(raw: unknown): MediaAssetInfo {
  if (!isRecord(raw)) bad("asset info must be an object");
  if (!isSafeId(raw.id)) bad("asset id is not a plain identifier");
  if (typeof raw.name !== "string" || raw.name.length > 1024) bad(`asset ${raw.id} needs a name`);
  if (typeof raw.type !== "string" || !MEDIA_TYPES.includes(raw.type as MediaType)) bad(`asset ${raw.id} has an unknown media type`);
  if (typeof raw.size !== "number" || !Number.isFinite(raw.size) || raw.size < 0) bad(`asset ${raw.id} has an invalid size`);
  if (typeof raw.lastModified !== "number" || !Number.isFinite(raw.lastModified)) bad(`asset ${raw.id} has an invalid lastModified`);
  return raw as unknown as MediaAssetInfo;
}

function readEntryRef(raw: unknown, expectedPath: string, what: string, maxSize: number): BundleEntryRef {
  if (!isRecord(raw)) bad(`${what} must be an object`);
  if (raw.path !== expectedPath) throw new BundleError("unsafe-path", `Bundle ${what} points at ${JSON.stringify(String(raw.path).slice(0, 80))}, expected ${expectedPath}`);
  return { path: expectedPath, size: readSize(raw.size, what, maxSize), sha256: readSha(raw.sha256, what) };
}

/** Validates an untrusted manifest. Paths are not trusted: each must equal the canonical path derived from its id. */
export function parseManifest(raw: unknown): BundleManifest {
  if (!isRecord(raw)) bad("not an object");
  if (raw.format !== BUNDLE_FORMAT) throw new BundleError("not-a-bundle", "This file is not a RunItBack project bundle");
  if (typeof raw.bundleVersion !== "number" || !Number.isInteger(raw.bundleVersion) || raw.bundleVersion < 1) bad("bundleVersion");
  if (raw.bundleVersion > BUNDLE_VERSION) throw new BundleError("newer-version", `This bundle uses format v${raw.bundleVersion}; this app reads up to v${BUNDLE_VERSION}`);
  if (typeof raw.schemaVersion !== "number" || !Number.isInteger(raw.schemaVersion) || raw.schemaVersion < 0) bad("schemaVersion");
  if (raw.schemaVersion > PROJECT_SCHEMA_VERSION) {
    throw new BundleError("newer-version", `This project was exported by a newer version of RunItBack (project schema v${raw.schemaVersion}; this app supports v${PROJECT_SCHEMA_VERSION})`);
  }
  if (typeof raw.createdAt !== "string" || typeof raw.createdWith !== "string") bad("createdAt/createdWith");
  const projectRef = readEntryRef(raw.project, PROJECT_PATH, "project", BUNDLE_LIMITS.maxProjectBytes);
  const projectName = isRecord(raw.project) && typeof raw.project.name === "string" ? raw.project.name.slice(0, 512) : "Imported project";

  if (!Array.isArray(raw.assets) || !Array.isArray(raw.derived)) bad("assets and derived must be lists");
  if (raw.assets.length > BUNDLE_LIMITS.maxAssets) throw new BundleError("too-large", `Bundle lists ${raw.assets.length} assets (limit ${BUNDLE_LIMITS.maxAssets})`);
  if (raw.derived.length > BUNDLE_LIMITS.maxAssets * DERIVED_KINDS.length) throw new BundleError("too-large", "Bundle lists too many derived entries");

  const seen = new Set<string>();
  const assets: BundleAssetEntry[] = raw.assets.map((entry: unknown) => {
    const info = readAssetInfo(isRecord(entry) ? entry.info : undefined);
    if (seen.has(info.id)) bad(`asset ${info.id} is listed twice`);
    seen.add(info.id);
    const ref = readEntryRef(entry, assetPath(info.id), `asset ${info.id}`, BUNDLE_LIMITS.maxBundleBytes);
    return { ...ref, info };
  });

  const derivedSeen = new Set<string>();
  const derived: BundleDerivedEntry[] = raw.derived.map((entry: unknown) => {
    if (!isRecord(entry)) bad("derived entry must be an object");
    const { kind, assetId } = entry;
    if (typeof kind !== "string" || !(DERIVED_KINDS as readonly string[]).includes(kind)) bad("derived entry has an unknown kind");
    if (!isSafeId(assetId) || !seen.has(assetId)) bad("derived entry refers to an asset that is not in the bundle");
    const id = `${kind}/${assetId}`;
    if (derivedSeen.has(id)) bad(`derived ${id} is listed twice`);
    derivedSeen.add(id);
    const ref = readEntryRef(entry, derivedPath(kind as DerivedKind, assetId), `derived ${id}`, BUNDLE_LIMITS.maxDerivedEntryBytes);
    return { ...ref, assetId, kind: kind as DerivedKind };
  });

  const manifest: BundleManifest = {
    format: BUNDLE_FORMAT, bundleVersion: raw.bundleVersion, app: "runitback", createdAt: raw.createdAt, createdWith: raw.createdWith,
    schemaVersion: raw.schemaVersion, project: { ...projectRef, name: projectName }, assets, derived,
  };
  const total = declaredBundleBytes(manifest);
  if (total > BUNDLE_LIMITS.maxBundleBytes) throw new BundleError("too-large", `Bundle declares ${total} bytes of content, over the ${BUNDLE_LIMITS.maxBundleBytes} byte limit`);
  return manifest;
}

export function declaredBundleBytes(manifest: BundleManifest): number {
  return manifest.project.size + manifest.assets.reduce((n, a) => n + a.size, 0) + manifest.derived.reduce((n, d) => n + d.size, 0);
}

export function buildManifest(input: {
  project: Project; projectEntry: Omit<BundleEntryRef, "path">; assets: ReadonlyArray<{ info: MediaAssetInfo; size: number; sha256: string }>;
  derived: ReadonlyArray<{ kind: DerivedKind; assetId: string; size: number; sha256: string }>; createdAt: string; createdWith: string;
}): BundleManifest {
  return {
    format: BUNDLE_FORMAT, bundleVersion: BUNDLE_VERSION, app: "runitback", createdAt: input.createdAt, createdWith: input.createdWith,
    schemaVersion: input.project.version,
    project: { path: PROJECT_PATH, ...input.projectEntry, name: input.project.metadata.name },
    assets: input.assets.map((a) => ({ path: assetPath(a.info.id), size: a.size, sha256: a.sha256, info: a.info })),
    derived: input.derived.map((d) => ({ path: derivedPath(d.kind, d.assetId), kind: d.kind, assetId: d.assetId, size: d.size, sha256: d.sha256 })),
  };
}

/** Every file the manifest promises must be in the archive with the promised size, and nothing else may be. */
export function verifyArchiveAgainstManifest(manifest: BundleManifest, entries: ReadonlyMap<string, { size: number }>): void {
  const promised = new Map<string, number>([[MANIFEST_PATH, -1], [manifest.project.path, manifest.project.size]]);
  for (const a of manifest.assets) promised.set(a.path, a.size);
  for (const d of manifest.derived) promised.set(d.path, d.size);
  for (const name of entries.keys()) {
    if (!promised.has(name)) throw new BundleError("malformed", `Bundle contains an entry the manifest does not list: ${name}`);
  }
  for (const [path, size] of promised) {
    const entry = entries.get(path);
    if (!entry) throw new BundleError("missing-entry", `Bundle is missing ${path}`);
    if (size >= 0 && entry.size !== size) throw new BundleError("malformed", `${path} is ${entry.size} bytes but the manifest says ${size}`);
  }
}

export interface RemappedBundleProject {
  project: Project;
  /** Old asset id to new asset id. */
  assetIds: Map<string, string>;
  /** Every id (project, scene, track, element, effect, mask, keyframe, asset) to its replacement. */
  allIds: Map<string, string>;
}

function collectIds(value: unknown, into: Set<string>, depth: number): void {
  if (depth > BUNDLE_LIMITS.maxJsonDepth) throw new BundleError("malformed", "Project data is nested too deeply");
  if (Array.isArray(value)) {
    for (const item of value) collectIds(item, into, depth + 1);
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, child] of Object.entries(value)) {
    if (key === "__proto__") throw new BundleError("malformed", "Project data contains a reserved key");
    if (key === "id" && typeof child === "string") into.add(child);
    else collectIds(child, into, depth + 1);
  }
}

function rewrite(value: unknown, map: ReadonlyMap<string, string>): unknown {
  if (typeof value === "string") return map.get(value) ?? value;
  if (Array.isArray(value)) return value.map((item) => rewrite(item, map));
  if (!isRecord(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) out[key] = rewrite(child, map);
  return out;
}

/**
 * Gives a project, and everything in it that carries an identity, fresh ids so it can live beside the project it was
 * exported from. Ids are discovered from every `id` field plus the asset list, then rewritten wherever they occur as a
 * value (references such as `mediaId`, `currentSceneId`, `assetIds`), so a reference can never be left pointing at the old id.
 */
export function remapProjectIds(input: { project: Project; assetIds: ReadonlyArray<string>; newId: IdGenerator }): RemappedBundleProject {
  const found = new Set<string>(input.assetIds);
  collectIds(input.project, found, 0);
  const allIds = new Map<string, string>();
  const used = new Set<string>();
  for (const old of found) {
    let fresh = input.newId();
    while (used.has(fresh) || found.has(fresh)) fresh = input.newId();
    used.add(fresh);
    allIds.set(old, fresh);
  }
  const project = rewrite(input.project, allIds) as Project;
  const assetIds = new Map(input.assetIds.map((id) => [id, allIds.get(id) as string]));
  return { project, assetIds, allIds };
}

/** Old ids still present as a string value anywhere in `value` (object keys are structure, never ids). */
export function findResidualIds(value: unknown, oldIds: ReadonlyArray<string>): string[] {
  const old = new Set(oldIds);
  const found = new Set<string>();
  const visit = (v: unknown): void => {
    if (typeof v === "string") {
      if (old.has(v)) found.add(v);
    } else if (Array.isArray(v)) {
      v.forEach(visit);
    } else if (isRecord(v)) {
      Object.values(v).forEach(visit);
    }
  };
  visit(value);
  return [...found];
}
