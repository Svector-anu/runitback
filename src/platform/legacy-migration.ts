import type { PrefsBackend } from "./prefs";

/** Storage names used before the product was renamed. Data under them is copied once, never deleted. */
export const LEGACY = { dbName: "opencut", styleDb: "opencut-style", prefix: "opencut:" } as const;
export const CURRENT = { dbName: "runitback", styleDb: "runitback-style", prefix: "runitback:" } as const;
export const MIGRATION_MARKER = `${CURRENT.prefix}legacy-migrated`;

export interface MigrationReport {
  alreadyDone: boolean;
  databases: string[];
  records: number;
  prefs: number;
}

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB request failed"));
  });
}

async function databaseExists(factory: IDBFactory, name: string): Promise<boolean> {
  if (typeof factory.databases !== "function") return true;
  const all = await factory.databases();
  return all.some((d) => d.name === name);
}

function openExisting(factory: IDBFactory, name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = factory.open(name);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error(`Could not open ${name}`));
  });
}

interface StoreShape {
  name: string;
  keyPath: string | string[] | null;
}

function openTarget(factory: IDBFactory, name: string, stores: StoreShape[]): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = factory.open(name, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const s of stores) {
        if (!db.objectStoreNames.contains(s.name)) db.createObjectStore(s.name, s.keyPath ? { keyPath: s.keyPath } : undefined);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error(`Could not open ${name}`));
  });
}

async function copyDatabase(factory: IDBFactory, from: string, to: string): Promise<number> {
  if (!(await databaseExists(factory, from))) return 0;
  const source = await openExisting(factory, from);
  let copied = 0;
  try {
    const names = [...source.objectStoreNames];
    if (names.length === 0) return 0;
    const shapes: StoreShape[] = names.map((n) => {
      const store = source.transaction(n, "readonly").objectStore(n);
      return { name: n, keyPath: store.keyPath };
    });
    const target = await openTarget(factory, to, shapes);
    try {
      for (const shape of shapes) {
        const readStore = source.transaction(shape.name, "readonly").objectStore(shape.name);
        const [keys, values] = await Promise.all([request(readStore.getAllKeys()), request(readStore.getAll())]);
        const tx = target.transaction(shape.name, "readwrite");
        const writeStore = tx.objectStore(shape.name);
        for (let i = 0; i < values.length; i++) {
          const existing = await request(writeStore.getKey(keys[i] as IDBValidKey));
          if (existing !== undefined) continue;
          if (writeStore.keyPath) writeStore.put(values[i]);
          else writeStore.put(values[i], keys[i] as IDBValidKey);
          copied++;
        }
        await new Promise<void>((resolve, reject) => {
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error ?? new Error("copy failed"));
          tx.onabort = () => reject(tx.error ?? new Error("copy aborted"));
        });
      }
    } finally {
      target.close();
    }
  } finally {
    source.close();
  }
  return copied;
}

/**
 * One-time copy of projects, media metadata and preferences from the pre-rename storage names.
 * Existing records under the new names always win, the legacy data is left in place, and a marker makes it idempotent.
 * Media bytes in OPFS are keyed by project id (not by product name) so they need no copy.
 */
export async function migrateLegacyStorage(input: { factory: IDBFactory; prefs: PrefsBackend }): Promise<MigrationReport> {
  const { factory, prefs } = input;
  if (prefs.getItem(MIGRATION_MARKER) === "1") return { alreadyDone: true, databases: [], records: 0, prefs: 0 };

  const databases: string[] = [];
  let records = 0;
  for (const [from, to] of [[LEGACY.dbName, CURRENT.dbName], [LEGACY.styleDb, CURRENT.styleDb]] as const) {
    const count = await copyDatabase(factory, from, to);
    if (count > 0) databases.push(to);
    records += count;
  }

  let prefCount = 0;
  const names: string[] = [];
  for (let i = 0; i < (prefs.length ?? 0); i++) {
    const name = prefs.key?.(i);
    if (name) names.push(name);
  }
  for (const key of names) {
    if (!key.startsWith(LEGACY.prefix)) continue;
    const next = CURRENT.prefix + key.slice(LEGACY.prefix.length);
    if (prefs.getItem(next) === null) {
      const value = prefs.getItem(key);
      if (value !== null) {
        prefs.setItem(next, value);
        prefCount++;
      }
    }
  }
  prefs.setItem(MIGRATION_MARKER, "1");
  return { alreadyDone: false, databases, records, prefs: prefCount };
}
