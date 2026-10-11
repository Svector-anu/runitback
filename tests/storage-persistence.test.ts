import { describe, expect, it, vi } from "vitest";
import { StoragePersistence, estimateStorage, formatStorageBytes, type StorageManagerLike } from "#/platform/file-store";
import { PrefsStore, STORAGE_PERSIST_PREF, type PrefsBackend } from "#/platform/prefs";

function prefs(): PrefsStore {
  const map = new Map<string, string>();
  const backend: PrefsBackend = { getItem: (k) => map.get(k) ?? null, setItem: (k, v) => void map.set(k, v) };
  return new PrefsStore(backend);
}

describe("StoragePersistence", () => {
  it("asks once, records the answer and never asks again", async () => {
    const persist = vi.fn(async () => true);
    const p = prefs();
    const a = new StoragePersistence({ storage: { persist, persisted: async () => false }, prefs: p });
    expect(await a.requestOnce()).toBe("granted");
    expect(await a.requestOnce()).toBe("granted");
    const b = new StoragePersistence({ storage: { persist }, prefs: p });
    expect(await b.requestOnce()).toBe("granted");
    expect(persist).toHaveBeenCalledTimes(1);
    expect(await a.takeNotice()).toBeNull();
  });

  it("skips the request when storage is already persisted", async () => {
    const persist = vi.fn(async () => false);
    const a = new StoragePersistence({ storage: { persist, persisted: async () => true }, prefs: prefs() });
    expect(await a.requestOnce()).toBe("granted");
    expect(persist).not.toHaveBeenCalled();
  });

  it("shows the refusal notice exactly once, with the quota estimate", async () => {
    const storage: StorageManagerLike = { persist: async () => false, estimate: async () => ({ usage: 50 * 1024 * 1024, quota: 2 * 1024 ** 3 }) };
    const p = prefs();
    const a = new StoragePersistence({ storage, prefs: p });
    expect(await a.takeNotice()).toBeNull();
    await a.requestOnce();
    const notice = await a.takeNotice();
    expect(notice).toContain("50 MB");
    expect(notice).toContain("2.0 GB");
    expect(await a.takeNotice()).toBeNull();
    expect(await new StoragePersistence({ storage, prefs: p }).takeNotice()).toBeNull();
  });

  it("treats a missing or throwing Storage API as unsupported and stays quiet", async () => {
    const none = new StoragePersistence({ storage: undefined, prefs: prefs() });
    expect(await none.requestOnce()).toBe("unsupported");
    expect(await none.takeNotice()).toBeNull();
    const throwing = new StoragePersistence({ storage: { persist: async () => { throw new Error("no"); } }, prefs: prefs() });
    expect(await throwing.requestOnce()).toBe("unsupported");
  });

  it("ignores a corrupt stored value and records only through prefs", async () => {
    const p = prefs();
    p.write(STORAGE_PERSIST_PREF, { outcome: "bogus" });
    const persist = vi.fn(async () => false);
    expect(await new StoragePersistence({ storage: { persist }, prefs: p }).requestOnce()).toBe("denied");
    expect(persist).toHaveBeenCalledTimes(1);
  });

  it("estimates and formats", async () => {
    expect(await estimateStorage({ estimate: async () => ({ usage: 1, quota: 0 }) })).toBeNull();
    expect(await estimateStorage({ estimate: async () => { throw new Error("x"); } })).toBeNull();
    expect(formatStorageBytes(10)).toBe("1 KB");
  });
});
