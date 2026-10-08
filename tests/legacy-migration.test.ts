import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { CURRENT, LEGACY, MIGRATION_MARKER, migrateLegacyStorage } from "#/platform/legacy-migration";
import type { PrefsBackend } from "#/platform/prefs";

function memoryPrefs(initial: Record<string, string> = {}): PrefsBackend & { dump(): Record<string, string> } {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    get length() { return map.size; },
    key: (i) => [...map.keys()][i] ?? null,
    dump: () => Object.fromEntries(map),
  };
}

function seed(name: string, records: Array<{ id: string; v: number }>): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(name, 1);
    req.onupgradeneeded = () => void req.result.createObjectStore("projects", { keyPath: "id" });
    req.onsuccess = () => {
      const db = req.result;
      const tx = db.transaction("projects", "readwrite");
      for (const r of records) tx.objectStore("projects").put(r);
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onerror = () => reject(tx.error);
    };
  });
}

function readAll(name: string): Promise<Array<{ id: string; v: number }>> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(name);
    req.onsuccess = () => {
      const db = req.result;
      const get = db.transaction("projects").objectStore("projects").getAll();
      get.onsuccess = () => { db.close(); resolve(get.result as Array<{ id: string; v: number }>); };
      get.onerror = () => reject(get.error);
    };
  });
}

describe("migrateLegacyStorage", () => {
  it("copies legacy projects and prefs, keeps the originals, and is idempotent", async () => {
    await seed(LEGACY.dbName, [{ id: "a", v: 1 }, { id: "b", v: 2 }]);
    const prefs = memoryPrefs({ [`${LEGACY.prefix}snapping`]: "true", other: "x" });

    const first = await migrateLegacyStorage({ factory: indexedDB, prefs });
    expect(first.alreadyDone).toBe(false);
    expect(first.records).toBe(2);
    expect(first.prefs).toBe(1);
    expect((await readAll(CURRENT.dbName)).map((r) => r.id).sort()).toEqual(["a", "b"]);
    expect(await readAll(LEGACY.dbName)).toHaveLength(2);
    expect(prefs.getItem(`${CURRENT.prefix}snapping`)).toBe("true");
    expect(prefs.getItem(`${LEGACY.prefix}snapping`)).toBe("true");
    expect(prefs.getItem(MIGRATION_MARKER)).toBe("1");

    const second = await migrateLegacyStorage({ factory: indexedDB, prefs });
    expect(second.alreadyDone).toBe(true);
  });

  it("never overwrites data already present under the new names", async () => {
    await seed(CURRENT.dbName, [{ id: "a", v: 99 }]);
    const prefs = memoryPrefs({ [`${LEGACY.prefix}ripple`]: "true", [`${CURRENT.prefix}ripple`]: "false" });
    await migrateLegacyStorage({ factory: indexedDB, prefs });
    const rows = await readAll(CURRENT.dbName);
    expect(rows.find((r) => r.id === "a")?.v).toBe(99);
    expect(prefs.getItem(`${CURRENT.prefix}ripple`)).toBe("false");
  });
});
