import { BufferTarget, StreamTarget, type Target } from "mediabunny";

const EXPORT_DIRECTORY = "runitback-exports";
const STALE_AFTER_MS = 60 * 60 * 1000;

export interface ExportTarget {
  target: Target;
  /** The finished file. Call only after the output was finalized. */
  result(): Promise<Blob>;
  /** Releases anything written so far; safe to call after `result`. */
  discard(): Promise<void>;
}

function bufferedTarget(mimeType: string): ExportTarget {
  const target = new BufferTarget();
  return {
    target,
    result: async () => {
      if (!target.buffer) throw new Error("Export produced no data");
      return new Blob([target.buffer], { type: mimeType });
    },
    discard: async () => undefined,
  };
}

/** `entries()` is in every browser that has OPFS but missing from TypeScript's DOM library. */
type IterableDirectory = FileSystemDirectoryHandle & { entries(): AsyncIterable<[string, FileSystemHandle]> };

async function removeStaleExports(directory: FileSystemDirectoryHandle): Promise<void> {
  const stale: string[] = [];
  for await (const [name, handle] of (directory as IterableDirectory).entries()) {
    if (handle.kind !== "file") continue;
    const file = await (handle as FileSystemFileHandle).getFile();
    if (Date.now() - file.lastModified > STALE_AFTER_MS) stale.push(name);
  }
  await Promise.all(stale.map((name) => directory.removeEntry(name).catch(() => undefined)));
}

/**
 * Writes the muxed file straight to the origin-private file system, so peak memory does not grow with the
 * output size (a 4K export is hundreds of MB). Falls back to an in-memory buffer where OPFS is unavailable.
 */
export async function createExportTarget(input: { mimeType: string; extension: string }): Promise<ExportTarget> {
  if (typeof navigator === "undefined" || typeof navigator.storage?.getDirectory !== "function") return bufferedTarget(input.mimeType);
  try {
    const root = await navigator.storage.getDirectory();
    const directory = await root.getDirectoryHandle(EXPORT_DIRECTORY, { create: true });
    await removeStaleExports(directory);
    const name = `${crypto.randomUUID()}.${input.extension}`;
    const handle = await directory.getFileHandle(name, { create: true });
    const writable = await handle.createWritable();
    const stream = new WritableStream<{ data: Uint8Array<ArrayBuffer>; position: number }>({
      write: (chunk) => writable.write({ type: "write", position: chunk.position, data: chunk.data }),
      close: () => writable.close(),
      abort: () => writable.abort(),
    });
    return {
      target: new StreamTarget(stream, { chunked: true }),
      result: async () => new Blob([await handle.getFile()], { type: input.mimeType }),
      discard: () => directory.removeEntry(name).catch(() => undefined),
    };
  } catch {
    return bufferedTarget(input.mimeType);
  }
}
