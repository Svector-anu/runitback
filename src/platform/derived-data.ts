import type { DerivedDataPurger, DerivedKind } from "#/engine/persistence";
import type { MediaAssetInfo } from "#/engine/model";

export interface DerivedExportOptions {
  /** Embeddings are the bulky kind; above `SMALL_EMBEDDINGS_BYTES` they are only exported when this is true. */
  includeEmbeddings: boolean;
}

/** One kind of per-asset derived data (analysis, transcript, embeddings, faces). */
export interface DerivedDataStore {
  readonly kind: DerivedKind;
  /** Removes everything this store holds for the asset. Must succeed when there is nothing to remove. */
  deleteAsset(assetId: string): Promise<void>;
  /** Asset ids with data in this store. */
  assetIds(): Promise<string[]>;
  /** JSON-safe snapshot for a bundle, or undefined when there is nothing (or nothing worth exporting). */
  exportAsset(info: MediaAssetInfo, options: DerivedExportOptions): Promise<unknown | undefined>;
  /** Stores a snapshot for `info.id`. Returns false when the payload is not usable (derived data is optional, so this never throws for bad data). */
  importAsset(info: MediaAssetInfo, payload: unknown): Promise<boolean>;
}

export class DerivedDataPurgeError extends Error {
  constructor(readonly failures: ReadonlyArray<{ kind: DerivedKind; assetId: string; cause: unknown }>) {
    super(`Could not remove derived data: ${failures.map((f) => `${f.kind}/${f.assetId}`).join(", ")}`);
    this.name = "DerivedDataPurgeError";
  }
}

/**
 * Every store of per-asset derived data registers here once; the app asks the registry, never the individual stores,
 * to delete, list, export or import an asset's data. A new kind of derived data is only correct once it is registered.
 */
export class DerivedDataRegistry implements DerivedDataPurger {
  private readonly byKind = new Map<DerivedKind, DerivedDataStore>();

  register(store: DerivedDataStore): this {
    if (this.byKind.has(store.kind)) throw new Error(`Derived data store "${store.kind}" is already registered`);
    this.byKind.set(store.kind, store);
    return this;
  }

  get stores(): DerivedDataStore[] {
    return [...this.byKind.values()];
  }

  store(kind: DerivedKind): DerivedDataStore | undefined {
    return this.byKind.get(kind);
  }

  purgeAsset(assetId: string): Promise<void> {
    return this.purgeAssets([assetId]);
  }

  /** Tries every store for every asset even when some fail, then reports all failures together. */
  async purgeAssets(assetIds: ReadonlyArray<string>): Promise<void> {
    const failures: Array<{ kind: DerivedKind; assetId: string; cause: unknown }> = [];
    for (const assetId of new Set(assetIds)) {
      await Promise.all(this.stores.map(async (store) => {
        try {
          await store.deleteAsset(assetId);
        } catch (cause) {
          failures.push({ kind: store.kind, assetId, cause });
        }
      }));
    }
    if (failures.length > 0) throw new DerivedDataPurgeError(failures);
  }

  async listAssetIds(): Promise<string[]> {
    const ids = new Set<string>();
    for (const store of this.stores) for (const id of await store.assetIds()) ids.add(id);
    return [...ids];
  }
}
