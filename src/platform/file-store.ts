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
