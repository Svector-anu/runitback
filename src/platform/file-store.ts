import { STORAGE_PERSIST_PREF, isStoragePersistRecord, type PersistOutcome, type PrefsStore, type StoragePersistRecord } from "./prefs";

/** Byte storage for media files, keyed by `<projectId>/<assetId>`. */
export interface FileStore {
  put(key: string, blob: Blob): Promise<void>;
  get(key: string): Promise<Blob | null>;
  delete(key: string): Promise<void>;
  deletePrefix(prefix: string): Promise<void>;
}

export class MemoryFileStore implements FileStore {
  readonly files = new Map<string, Blob>();
  async put(key: string, blob: Blob): Promise<void> { this.files.set(key, blob); }
  async get(key: string): Promise<Blob | null> { return this.files.get(key) ?? null; }
  async delete(key: string): Promise<void> { this.files.delete(key); }
  async deletePrefix(prefix: string): Promise<void> {
    for (const key of [...this.files.keys()]) if (key.startsWith(prefix)) this.files.delete(key);
  }
}

function splitKey(key: string): { dir: string; name: string } {
  const slash = key.indexOf("/");
  return { dir: `media-${key.slice(0, slash)}`, name: key.slice(slash + 1) };
}

/** Origin-private file system: large media stays out of IndexedDB and off the main heap. */
export class OpfsFileStore implements FileStore {
  private root: Promise<FileSystemDirectoryHandle> | null = null;

  static isSupported(): boolean {
    return typeof navigator !== "undefined" && !!navigator.storage && typeof navigator.storage.getDirectory === "function";
  }

  private getRoot(): Promise<FileSystemDirectoryHandle> {
    this.root ??= navigator.storage.getDirectory();
    return this.root;
  }

  private async dir(name: string, create: boolean): Promise<FileSystemDirectoryHandle | null> {
    try {
      return await (await this.getRoot()).getDirectoryHandle(name, { create });
    } catch (error) {
      if (!create && error instanceof DOMException && error.name === "NotFoundError") return null;
      throw error;
    }
  }

  async put(key: string, blob: Blob): Promise<void> {
    const { dir, name } = splitKey(key);
    const handle = await (await this.dir(dir, true) as FileSystemDirectoryHandle).getFileHandle(name, { create: true });
    const writable = await handle.createWritable();
    try {
      await writable.write(blob);
      await writable.close();
    } catch (error) {
      await writable.abort().catch(() => undefined);
      await this.delete(key).catch(() => undefined);
      throw error;
    }
  }

  async get(key: string): Promise<Blob | null> {
    const { dir, name } = splitKey(key);
    const d = await this.dir(dir, false);
    if (!d) return null;
    try {
      return await (await d.getFileHandle(name)).getFile();
    } catch (error) {
      if (error instanceof DOMException && error.name === "NotFoundError") return null;
      throw error;
    }
  }

  async delete(key: string): Promise<void> {
    const { dir, name } = splitKey(key);
    const d = await this.dir(dir, false);
    if (!d) return;
    await d.removeEntry(name).catch((error: unknown) => {
      if (!(error instanceof DOMException && error.name === "NotFoundError")) throw error;
    });
  }

  async deletePrefix(prefix: string): Promise<void> {
    const projectId = prefix.replace(/\/$/, "");
    await (await this.getRoot()).removeEntry(`media-${projectId}`, { recursive: true }).catch((error: unknown) => {
      if (!(error instanceof DOMException && error.name === "NotFoundError")) throw error;
    });
  }
}

export interface StorageEstimate {
  usage: number;
  quota: number;
}

/** The slice of `navigator.storage` this module uses; tests substitute a fake. */
export interface StorageManagerLike {
  persist?(): Promise<boolean>;
  persisted?(): Promise<boolean>;
  estimate?(): Promise<{ usage?: number; quota?: number }>;
}

export async function estimateStorage(storage: StorageManagerLike | undefined): Promise<StorageEstimate | null> {
  try {
    const estimate = await storage?.estimate?.();
    if (estimate?.usage === undefined || estimate.quota === undefined || estimate.quota <= 0) return null;
    return { usage: estimate.usage, quota: estimate.quota };
  } catch {
    return null;
  }
}

export function formatStorageBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  if (bytes < 1024 ** 3) return `${Math.round(bytes / 1024 ** 2)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

/**
 * Asks the browser to make this origin's storage durable (exempt from eviction under pressure), once, after the user has
 * something worth keeping. The answer is recorded in prefs and never asked again; a refusal produces at most one notice.
 */
export class StoragePersistence {
  private asked = false;

  constructor(private readonly deps: { storage: StorageManagerLike | undefined; prefs: PrefsStore; now?: () => string }) {}

  private read(): StoragePersistRecord | null {
    return this.deps.prefs.read<StoragePersistRecord | null>(STORAGE_PERSIST_PREF, null, (v): v is StoragePersistRecord | null => v === null || isStoragePersistRecord(v));
  }

  outcome(): PersistOutcome | null {
    return this.read()?.outcome ?? null;
  }

  async requestOnce(): Promise<PersistOutcome> {
    const existing = this.read();
    if (existing) return existing.outcome;
    if (this.asked) return "unsupported";
    this.asked = true;
    const outcome = await this.ask();
    this.deps.prefs.write(STORAGE_PERSIST_PREF, { outcome, requestedAt: (this.deps.now ?? (() => new Date().toISOString()))(), noticeShown: false } satisfies StoragePersistRecord);
    return outcome;
  }

  private async ask(): Promise<PersistOutcome> {
    const { storage } = this.deps;
    if (!storage || typeof storage.persist !== "function") return "unsupported";
    try {
      if (typeof storage.persisted === "function" && (await storage.persisted())) return "granted";
      return (await storage.persist()) ? "granted" : "denied";
    } catch {
      return "unsupported";
    }
  }

  /** The refusal message, exactly once per browser profile; null when granted, unsupported, unasked or already shown. */
  async takeNotice(): Promise<string | null> {
    const record = this.read();
    if (!record || record.outcome !== "denied" || record.noticeShown) return null;
    this.deps.prefs.write(STORAGE_PERSIST_PREF, { ...record, noticeShown: true });
    const estimate = await estimateStorage(this.deps.storage);
    const usage = estimate ? ` This site is using ${formatStorageBytes(estimate.usage)} of about ${formatStorageBytes(estimate.quota)} available.` : "";
    return `Your browser did not grant durable storage, so it may clear your projects if the disk runs low.${usage} Use Export project to keep a backup.`;
  }
}
