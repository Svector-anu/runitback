import type { VisualEmbeddings, VisualStore } from "#/engine/visual";
import { KeyValueStore, openDatabase } from "#/platform/idb";

export const VISUAL_DB_NAME = "runitback-visual";
export const VISUAL_DB_VERSION = 1;
const VISUAL_STORE = "embeddings";

/** Embeddings persist in their own database so the project database version never changes. Each record carries its model and version. */
export class IdbVisualStore implements VisualStore {
  private readonly store: KeyValueStore<VisualEmbeddings>;

  constructor(factory?: IDBFactory) {
    const db = openDatabase({ name: VISUAL_DB_NAME, version: VISUAL_DB_VERSION, stores: [{ name: VISUAL_STORE }], factory });
    this.store = new KeyValueStore<VisualEmbeddings>(db, VISUAL_STORE);
  }

  get(assetId: string): Promise<VisualEmbeddings | undefined> {
    return this.store.get(assetId);
  }

  save(embeddings: VisualEmbeddings): Promise<void> {
    return this.store.put(embeddings, embeddings.assetId);
  }

  delete(assetId: string): Promise<void> {
    return this.store.delete(assetId);
  }
}
