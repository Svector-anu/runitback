import type { MediaAnalysis } from "#/engine/analysis";
import { KeyValueStore, openDatabase } from "#/platform/idb";

export const ANALYSIS_DB_NAME = "runitback-analysis";
export const ANALYSIS_DB_VERSION = 1;
const ANALYSIS_STORE = "analysis";

export interface AnalysisStore {
  get(key: string): Promise<MediaAnalysis | undefined>;
  put(key: string, value: MediaAnalysis): Promise<void>;
  delete(key: string): Promise<void>;
  /** Removes every entry of an asset (keys are `<assetId>:<size>:<lastModified>`, so one asset may have several). */
  deleteAsset(assetId: string): Promise<void>;
  /** Asset ids that have at least one entry. */
  assetIds(): Promise<string[]>;
}

export function assetIdOfKey(key: string): string {
  const colon = key.indexOf(":");
  return colon < 0 ? key : key.slice(0, colon);
}

export function analysisCacheKey(info: { id: string; size: number; lastModified: number }): string {
  return `${info.id}:${info.size}:${info.lastModified}`;
}

export class MemoryAnalysisStore implements AnalysisStore {
  private readonly entries = new Map<string, MediaAnalysis>();

  async get(key: string): Promise<MediaAnalysis | undefined> {
    return this.entries.get(key);
  }

  async put(key: string, value: MediaAnalysis): Promise<void> {
    this.entries.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.entries.delete(key);
  }

  async deleteAsset(assetId: string): Promise<void> {
    for (const key of [...this.entries.keys()]) if (assetIdOfKey(key) === assetId) this.entries.delete(key);
  }

  async assetIds(): Promise<string[]> {
    return [...new Set([...this.entries.keys()].map(assetIdOfKey))];
  }
}

/** Persists results in their own database so the project database schema/version is untouched. */
export class IdbAnalysisStore implements AnalysisStore {
  private readonly store: KeyValueStore<MediaAnalysis>;

  constructor(factory?: IDBFactory) {
    const db = openDatabase({ name: ANALYSIS_DB_NAME, version: ANALYSIS_DB_VERSION, stores: [{ name: ANALYSIS_STORE }], factory });
    this.store = new KeyValueStore<MediaAnalysis>(db, ANALYSIS_STORE);
  }

  get(key: string): Promise<MediaAnalysis | undefined> {
    return this.store.get(key);
  }

  put(key: string, value: MediaAnalysis): Promise<void> {
    return this.store.put(value, key);
  }

  delete(key: string): Promise<void> {
    return this.store.delete(key);
  }

  async deleteAsset(assetId: string): Promise<void> {
    for (const key of await this.store.keys()) {
      if (typeof key === "string" && assetIdOfKey(key) === assetId) await this.store.delete(key);
    }
  }

  async assetIds(): Promise<string[]> {
    const ids = new Set<string>();
    for (const key of await this.store.keys()) if (typeof key === "string") ids.add(assetIdOfKey(key));
    return [...ids];
  }
}
