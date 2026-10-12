export interface StoreSpec {
  name: string;
  keyPath?: string;
}

export function openDatabase(input: { name: string; version: number; stores: ReadonlyArray<StoreSpec>; factory?: IDBFactory }): Promise<IDBDatabase> {
  const factory = input.factory ?? indexedDB;
  return new Promise((resolve, reject) => {
    const request = factory.open(input.name, input.version);
    request.onupgradeneeded = () => {
      const db = request.result;
      for (const store of input.stores) {
        if (!db.objectStoreNames.contains(store.name)) {
          db.createObjectStore(store.name, store.keyPath ? { keyPath: store.keyPath } : undefined);
        }
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Could not open IndexedDB"));
    request.onblocked = () => reject(new Error("IndexedDB upgrade is blocked by another tab"));
  });
}

function asPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
  });
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("IndexedDB transaction failed"));
    tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted"));
  });
}

/** Small promise wrapper over one object store; the connection is opened once and reused. */
export class KeyValueStore<T> {
  constructor(private readonly dbPromise: Promise<IDBDatabase>, private readonly store: string) {}

  async get(key: IDBValidKey): Promise<T | undefined> {
    const db = await this.dbPromise;
    return asPromise(db.transaction(this.store, "readonly").objectStore(this.store).get(key) as IDBRequest<T | undefined>);
  }

  async put(value: T, key?: IDBValidKey): Promise<void> {
    const db = await this.dbPromise;
    const tx = db.transaction(this.store, "readwrite");
    tx.objectStore(this.store).put(value, key);
    await done(tx);
  }

  /** Atomic read-modify-write in one transaction; `decide` returns the value to store, or undefined to leave the row alone. Resolves whether it wrote. */
  async update(key: IDBValidKey, decide: (current: T | undefined) => T | undefined): Promise<boolean> {
    const db = await this.dbPromise;
    const tx = db.transaction(this.store, "readwrite");
    const objectStore = tx.objectStore(this.store);
    const current = await asPromise(objectStore.get(key) as IDBRequest<T | undefined>);
    const next = decide(current);
    if (next === undefined) return false;
    objectStore.put(next);
    await done(tx);
    return true;
  }

  async delete(key: IDBValidKey): Promise<void> {
    const db = await this.dbPromise;
    const tx = db.transaction(this.store, "readwrite");
    tx.objectStore(this.store).delete(key);
    await done(tx);
  }

  async getAll(): Promise<T[]> {
    const db = await this.dbPromise;
    return asPromise(db.transaction(this.store, "readonly").objectStore(this.store).getAll() as IDBRequest<T[]>);
  }

  async keys(): Promise<IDBValidKey[]> {
    const db = await this.dbPromise;
    return asPromise(db.transaction(this.store, "readonly").objectStore(this.store).getAllKeys());
  }

  async deleteRange(range: IDBKeyRange): Promise<void> {
    const db = await this.dbPromise;
    const tx = db.transaction(this.store, "readwrite");
    tx.objectStore(this.store).delete(range);
    await done(tx);
  }

  async getAllInRange(range: IDBKeyRange): Promise<T[]> {
    const db = await this.dbPromise;
    return asPromise(db.transaction(this.store, "readonly").objectStore(this.store).getAll(range) as IDBRequest<T[]>);
  }
}

/** Key range covering every string key that starts with `prefix`. */
export function prefixRange(prefix: string): IDBKeyRange {
  return IDBKeyRange.bound(prefix, `${prefix}￿`);
}
