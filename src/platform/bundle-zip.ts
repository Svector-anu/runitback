import { BUNDLE_LIMITS, BundleError, assertEntryName } from "#/engine/persistence";
import { crc32Update } from "./bundle-hash";

/**
 * Minimal zip container for `.runitback` bundles: 32-bit sizes, no encryption, entries either stored or raw-deflate.
 * Media is stored (it is already compressed) and read back as zero-copy `Blob.slice` views, so a bundle larger than
 * memory can be written and read without ever being held in the heap.
 */
const LOCAL_SIG = 0x04034b50;
const CENTRAL_SIG = 0x02014b50;
const END_SIG = 0x06054b50;
const END_SIZE = 22;
const MAX_COMMENT = 0xffff;
const UTF8_FLAG = 0x0800;
const ENCRYPTED_FLAG = 0x0001;
const DOS_DATE_1980 = 0x0021;
const MAX_U32 = 0xffff_ffff;
const MIN_COMPRESS_BYTES = 512;

export interface ZipEntry {
  name: string;
  method: 0 | 8;
  compressedSize: number;
  size: number;
  crc32: number;
  localOffset: number;
}

const encoder = new TextEncoder();

function compressionSupported(): boolean {
  return typeof CompressionStream === "function" && typeof DecompressionStream === "function";
}

async function pipeBytes(bytes: Uint8Array, transform: CompressionStream | DecompressionStream): Promise<Uint8Array<ArrayBuffer>> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(transform as unknown as ReadableWritablePair<Uint8Array, Uint8Array>);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export class ZipWriter {
  private readonly parts: BlobPart[] = [];
  private readonly central: Uint8Array[] = [];
  private readonly names = new Set<string>();
  private offset = 0;

  private push(part: BlobPart, length: number): void {
    this.parts.push(part);
    this.offset += length;
    if (this.offset > BUNDLE_LIMITS.maxBundleBytes) throw new BundleError("too-large", "Project is too large for a single bundle file (4 GiB limit)");
  }

  private addEntry(input: { name: string; method: 0 | 8; crc32: number; size: number; data: Blob | Uint8Array; dataLength: number }): void {
    assertEntryName(input.name);
    if (this.names.has(input.name)) throw new BundleError("malformed", `Duplicate bundle entry ${input.name}`);
    this.names.add(input.name);
    const name = encoder.encode(input.name);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, LOCAL_SIG, true);
    local.setUint16(4, 20, true);
    local.setUint16(6, UTF8_FLAG, true);
    local.setUint16(8, input.method, true);
    local.setUint16(12, DOS_DATE_1980, true);
    local.setUint32(14, input.crc32, true);
    local.setUint32(18, input.dataLength, true);
    local.setUint32(22, input.size, true);
    local.setUint16(26, name.length, true);
    const localOffset = this.offset;
    this.push(local.buffer, 30);
    this.push(name as BlobPart, name.length);
    this.push(input.data as BlobPart, input.dataLength);

    const central = new DataView(new ArrayBuffer(46 + name.length));
    central.setUint32(0, CENTRAL_SIG, true);
    central.setUint16(4, 20, true);
    central.setUint16(6, 20, true);
    central.setUint16(8, UTF8_FLAG, true);
    central.setUint16(10, input.method, true);
    central.setUint16(14, DOS_DATE_1980, true);
    central.setUint32(16, input.crc32, true);
    central.setUint32(20, input.dataLength, true);
    central.setUint32(24, input.size, true);
    central.setUint16(28, name.length, true);
    central.setUint32(42, localOffset, true);
    new Uint8Array(central.buffer).set(name, 46);
    this.central.push(new Uint8Array(central.buffer));
  }

  /** Adds a blob verbatim. `crc32` and `size` come from a prior `digestBlob` pass so the header can be written up front. */
  addStored(input: { name: string; blob: Blob; crc32: number }): void {
    this.addEntry({ name: input.name, method: 0, crc32: input.crc32, size: input.blob.size, data: input.blob, dataLength: input.blob.size });
  }

  /** Adds in-memory bytes, deflated when that is available and worthwhile. */
  async addBytes(name: string, bytes: Uint8Array): Promise<void> {
    const crc32 = crc32Update(0, bytes);
    if (compressionSupported() && bytes.length >= MIN_COMPRESS_BYTES) {
      const deflated = await pipeBytes(bytes, new CompressionStream("deflate-raw"));
      if (deflated.length < bytes.length) {
        this.addEntry({ name, method: 8, crc32, size: bytes.length, data: deflated, dataLength: deflated.length });
        return;
      }
    }
    this.addEntry({ name, method: 0, crc32, size: bytes.length, data: bytes, dataLength: bytes.length });
  }

  finish(): Blob {
    const centralOffset = this.offset;
    let centralSize = 0;
    for (const record of this.central) {
      this.parts.push(record as BlobPart);
      centralSize += record.length;
    }
    const end = new DataView(new ArrayBuffer(END_SIZE));
    end.setUint32(0, END_SIG, true);
    end.setUint16(8, this.central.length, true);
    end.setUint16(10, this.central.length, true);
    end.setUint32(12, centralSize, true);
    end.setUint32(16, centralOffset, true);
    this.parts.push(end.buffer);
    return new Blob(this.parts, { type: "application/zip" });
  }
}

export class ZipArchive {
  private constructor(private readonly source: Blob, readonly entries: ReadonlyMap<string, ZipEntry>) {}

  static async open(source: Blob): Promise<ZipArchive> {
    if (source.size < END_SIZE) throw new BundleError(source.size === 0 ? "not-a-bundle" : "truncated", "This file is too small to be a project bundle");
    const tailStart = Math.max(0, source.size - (END_SIZE + MAX_COMMENT));
    const tail = new DataView(await source.slice(tailStart).arrayBuffer());
    let end = -1;
    for (let i = tail.byteLength - END_SIZE; i >= 0; i--) {
      if (tail.getUint32(i, true) === END_SIG && i + END_SIZE + tail.getUint16(i + 20, true) === tail.byteLength) {
        end = i;
        break;
      }
    }
    if (end < 0) throw new BundleError("truncated", "The end of the file is missing. The bundle is incomplete or is not a RunItBack bundle");
    const count = tail.getUint16(end + 10, true);
    const centralSize = tail.getUint32(end + 12, true);
    const centralOffset = tail.getUint32(end + 16, true);
    if (count === 0xffff || centralSize === MAX_U32 || centralOffset === MAX_U32) throw new BundleError("unsupported", "Zip64 bundles are not supported");
    if (count > BUNDLE_LIMITS.maxEntries) throw new BundleError("too-large", `Bundle has ${count} entries (limit ${BUNDLE_LIMITS.maxEntries})`);
    if (centralOffset + centralSize > tailStart + end || centralSize > BUNDLE_LIMITS.maxManifestBytes) {
      throw new BundleError("truncated", "The bundle directory points outside the file; it is truncated or damaged");
    }
    const directory = new DataView(await source.slice(centralOffset, centralOffset + centralSize).arrayBuffer());
    const entries = new Map<string, ZipEntry>();
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let at = 0;
    for (let n = 0; n < count; n++) {
      if (at + 46 > directory.byteLength || directory.getUint32(at, true) !== CENTRAL_SIG) throw new BundleError("malformed", "Bundle directory is damaged");
      const flags = directory.getUint16(at + 8, true);
      const method = directory.getUint16(at + 10, true);
      const crc32 = directory.getUint32(at + 16, true);
      const compressedSize = directory.getUint32(at + 20, true);
      const size = directory.getUint32(at + 24, true);
      const nameLength = directory.getUint16(at + 28, true);
      const extraLength = directory.getUint16(at + 30, true);
      const commentLength = directory.getUint16(at + 32, true);
      const localOffset = directory.getUint32(at + 42, true);
      const next = at + 46 + nameLength + extraLength + commentLength;
      if (next > directory.byteLength) throw new BundleError("malformed", "Bundle directory is damaged");
      let name: string;
      try {
        name = decoder.decode(new Uint8Array(directory.buffer, at + 46, nameLength));
      } catch {
        throw new BundleError("unsafe-path", "Bundle contains an entry name that is not valid text");
      }
      assertEntryName(name);
      if (entries.has(name)) throw new BundleError("malformed", `Bundle lists ${name} twice`);
      if (flags & ENCRYPTED_FLAG) throw new BundleError("unsupported", "Encrypted bundles are not supported");
      if (method !== 0 && method !== 8) throw new BundleError("unsupported", `Unsupported compression method ${method} for ${name}`);
      if (compressedSize === MAX_U32 || size === MAX_U32 || localOffset === MAX_U32) throw new BundleError("unsupported", "Zip64 bundles are not supported");
      if (method === 0 && compressedSize !== size) throw new BundleError("malformed", `${name} is stored but its sizes disagree`);
      if (localOffset + 30 + nameLength + compressedSize > centralOffset) throw new BundleError("truncated", `${name} extends past the end of the data; the bundle is truncated`);
      entries.set(name, { name, method, compressedSize, size, crc32, localOffset });
      at = next;
    }
    const archive = new ZipArchive(source, entries);
    for (const entry of entries.values()) await archive.locate(entry);
    return archive;
  }

  private async locate(entry: ZipEntry): Promise<number> {
    const header = new DataView(await this.source.slice(entry.localOffset, entry.localOffset + 30).arrayBuffer());
    if (header.byteLength < 30 || header.getUint32(0, true) !== LOCAL_SIG) throw new BundleError("malformed", `${entry.name} has a damaged header`);
    const nameLength = header.getUint16(26, true);
    const extraLength = header.getUint16(28, true);
    const start = entry.localOffset + 30 + nameLength + extraLength;
    if (start + entry.compressedSize > this.source.size) throw new BundleError("truncated", `${entry.name} is cut off`);
    const storedName = new TextDecoder().decode(await this.source.slice(entry.localOffset + 30, entry.localOffset + 30 + nameLength).arrayBuffer());
    if (storedName !== entry.name) throw new BundleError("malformed", `${entry.name} has a mismatched header`);
    return start;
  }

  /** A lazy view over a stored entry's bytes; nothing is read until the blob is consumed. */
  async blob(name: string): Promise<Blob> {
    const entry = this.require(name);
    if (entry.method !== 0) throw new BundleError("unsupported", `${name} must be stored uncompressed`);
    const start = await this.locate(entry);
    return this.source.slice(start, start + entry.size);
  }

  /** Reads a small entry into memory, refusing anything that declares or expands beyond `maxBytes`. */
  async bytes(name: string, maxBytes: number): Promise<Uint8Array> {
    const entry = this.require(name);
    if (entry.size > maxBytes) throw new BundleError("too-large", `${name} declares ${entry.size} bytes, over the ${maxBytes} byte limit`);
    const start = await this.locate(entry);
    const raw = this.source.slice(start, start + entry.compressedSize);
    let data: Uint8Array;
    if (entry.method === 0) {
      data = new Uint8Array(await raw.arrayBuffer());
    } else {
      if (!compressionSupported()) throw new BundleError("unsupported", "This browser cannot decompress bundles");
      data = await inflateBounded(raw, entry.size, name);
    }
    if (data.length !== entry.size) throw new BundleError("malformed", `${name} is ${data.length} bytes but the directory says ${entry.size}`);
    if (crc32Update(0, data) !== entry.crc32) throw new BundleError("checksum-mismatch", `${name} failed its integrity check`);
    return data;
  }

  async json(name: string, maxBytes: number): Promise<unknown> {
    const bytes = await this.bytes(name, maxBytes);
    try {
      return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } catch {
      throw new BundleError("malformed", `${name} is not valid JSON`);
    }
  }

  private require(name: string): ZipEntry {
    const entry = this.entries.get(name);
    if (!entry) throw new BundleError("missing-entry", `Bundle is missing ${name}`);
    return entry;
  }
}

/** Inflates `raw`, failing as soon as the output exceeds the declared size (a deflate bomb declares small and expands huge). */
async function inflateBounded(raw: Blob, declared: number, name: string): Promise<Uint8Array> {
  const stream = raw.stream().pipeThrough(new DecompressionStream("deflate-raw") as unknown as ReadableWritablePair<Uint8Array, Uint8Array>);
  const reader = stream.getReader();
  const out = new Uint8Array(declared);
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (length + value.length > declared) throw new BundleError("malformed", `${name} expands beyond its declared size`);
      out.set(value, length);
      length += value.length;
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    if (error instanceof BundleError) throw error;
    throw new BundleError("malformed", `${name} is corrupt (could not be decompressed)`);
  }
  return out.subarray(0, length);
}
