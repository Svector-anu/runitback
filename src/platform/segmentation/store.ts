import { isUsableMaskTrack, type MaskStore, type MaskTrack } from "#/engine/segmentation";
import { KeyValueStore, openDatabase } from "#/platform/idb";
import { SEGMENTER_MODELS } from "./indexer";

export const MASK_DB_NAME = "runitback-masks";
export const MASK_DB_VERSION = 1;
const MASK_STORE = "masks";

const KNOWN_MODELS = new Set(Object.values(SEGMENTER_MODELS));

/** Mask tracks persist in their own database, keyed by asset id, so neither the project nor other derived-data databases change. */
export class IdbMaskStore implements MaskStore {
  private readonly store: KeyValueStore<MaskTrack>;

  constructor(factory?: IDBFactory) {
    const db = openDatabase({ name: MASK_DB_NAME, version: MASK_DB_VERSION, stores: [{ name: MASK_STORE }], factory });
    this.store = new KeyValueStore<MaskTrack>(db, MASK_STORE);
  }

  async get(assetId: string): Promise<MaskTrack | undefined> {
    const track = await this.store.get(assetId);
    return track && [...KNOWN_MODELS].some((model) => isUsableMaskTrack(track, model)) ? track : undefined;
  }

  save(track: MaskTrack): Promise<void> {
    return this.store.put(track, track.assetId);
  }

  delete(assetId: string): Promise<void> {
    return this.store.delete(assetId);
  }

  async assetIds(): Promise<string[]> {
    return (await this.store.keys()).filter((key): key is string => typeof key === "string");
  }
}

/** In-memory store for tests and for browsers without IndexedDB. */
export class MemoryMaskStore implements MaskStore {
  private readonly tracks = new Map<string, MaskTrack>();
  async get(assetId: string): Promise<MaskTrack | undefined> { return this.tracks.get(assetId); }
  async save(track: MaskTrack): Promise<void> { this.tracks.set(track.assetId, track); }
  async delete(assetId: string): Promise<void> { this.tracks.delete(assetId); }
  async assetIds(): Promise<string[]> { return [...this.tracks.keys()]; }
}
