import type { Editor } from "#/engine/editor";
import type { AnalysisProvider, StoredStyleProfile, StyleProfileStore } from "#/engine/reference";
import { analyzeMedia, type AnalysisStore } from "#/platform/analysis";
import { KeyValueStore, openDatabase } from "#/platform/idb";
import type { MediaRuntime } from "#/platform/media-runtime";

export const STYLE_DB_NAME = "opencut-style";
const STYLE_STORE = "profiles";

/** Style profiles persist in their own database so the project database version never changes. */
export class IdbStyleProfileStore implements StyleProfileStore {
  private readonly store: KeyValueStore<StoredStyleProfile>;

  constructor(factory?: IDBFactory) {
    const db = openDatabase({ name: STYLE_DB_NAME, version: 1, stores: [{ name: STYLE_STORE }], factory });
    this.store = new KeyValueStore<StoredStyleProfile>(db, STYLE_STORE);
  }

  async save(entry: StoredStyleProfile): Promise<void> {
    await this.store.put(entry, entry.id);
  }

  async get(id: string): Promise<StoredStyleProfile | undefined> {
    return this.store.get(id);
  }

  async list(): Promise<StoredStyleProfile[]> {
    const all = await this.store.getAll();
    return all.sort((a, b) => a.createdAtMs - b.createdAtMs || a.id.localeCompare(b.id));
  }
}

/** Analyses an imported asset on demand (cached) so reference tools can use any asset without a prior analyze_media call. */
export function createAnalysisProvider(deps: {
  editor: Editor; runtime: () => MediaRuntime; analysisStore: () => AnalysisStore; signal?: () => AbortSignal | undefined;
}): AnalysisProvider {
  return {
    async get(assetId) {
      const info = deps.editor.getAsset(assetId);
      const blob = deps.runtime().getBlob(assetId);
      if (!info || !blob) return undefined;
      return analyzeMedia(blob, info, { store: deps.analysisStore(), signal: deps.signal?.() });
    },
  };
}

let sharedStyleStore: StyleProfileStore | null = null;

export function getStyleProfileStore(): StyleProfileStore {
  sharedStyleStore ??= new IdbStyleProfileStore();
  return sharedStyleStore;
}

