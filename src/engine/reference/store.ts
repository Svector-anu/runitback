import type { StyleProfile } from "./types";

export interface StoredStyleProfile {
  id: string;
  name: string;
  createdAtMs: number;
  profile: StyleProfile;
}

/** Where saved style profiles live. The platform layer supplies a persistent implementation. */
export interface StyleProfileStore {
  save(entry: StoredStyleProfile): void | Promise<void>;
  get(id: string): StoredStyleProfile | undefined | Promise<StoredStyleProfile | undefined>;
  list(): StoredStyleProfile[] | Promise<StoredStyleProfile[]>;
}

export function createMemoryStyleProfileStore(): StyleProfileStore {
  const entries = new Map<string, StoredStyleProfile>();
  return {
    save: (entry) => { entries.set(entry.id, entry); },
    get: (id) => entries.get(id),
    list: () => [...entries.values()].sort((a, b) => a.createdAtMs - b.createdAtMs || a.id.localeCompare(b.id)),
  };
}
