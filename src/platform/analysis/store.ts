import type { MediaAnalysis } from "#/engine/analysis";
import { KeyValueStore, openDatabase } from "#/platform/idb";

export const ANALYSIS_DB_NAME = "opencut-analysis";
export const ANALYSIS_DB_VERSION = 1;
const ANALYSIS_STORE = "analysis";

export interface AnalysisStore {
  get(key: string): Promise<MediaAnalysis | undefined>;
  put(key: string, value: MediaAnalysis): Promise<void>;
  delete(key: string): Promise<void>;
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
}
