import type { FaceDetections, FaceStore } from "#/engine/face";
import { KeyValueStore, openDatabase } from "#/platform/idb";

export const FACE_DB_NAME = "runitback-faces";
export const FACE_DB_VERSION = 1;
const FACE_STORE = "detections";

/** Detections persist in their own database so neither the project nor the embeddings database version changes. Keyed by asset id. */
export class IdbFaceStore implements FaceStore {
  private readonly store: KeyValueStore<FaceDetections>;

  constructor(factory?: IDBFactory) {
    const db = openDatabase({ name: FACE_DB_NAME, version: FACE_DB_VERSION, stores: [{ name: FACE_STORE }], factory });
    this.store = new KeyValueStore<FaceDetections>(db, FACE_STORE);
  }

  get(assetId: string): Promise<FaceDetections | undefined> {
    return this.store.get(assetId);
  }

  save(detections: FaceDetections): Promise<void> {
    return this.store.put(detections, detections.assetId);
  }

  delete(assetId: string): Promise<void> {
    return this.store.delete(assetId);
  }

  async assetIds(): Promise<string[]> {
    return (await this.store.keys()).filter((key): key is string => typeof key === "string");
  }
}
