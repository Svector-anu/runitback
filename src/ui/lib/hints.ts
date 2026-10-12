import { useSyncExternalStore } from "react";
import { HINTS_SEEN_PREF, isStringArray, type PrefsStore } from "#/platform/prefs";
import { getServices } from "#/app/services";

export type HintId = "first-clip" | "plan-card" | "understand-intro" | "agent-key";

/** One-time hints. A hint is shown until it is dismissed (or its trigger happens once); Help can reset them all. */
export class HintStore {
  private seen: ReadonlySet<string>;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly prefs: Pick<PrefsStore, "read" | "write">) {
    this.seen = new Set(prefs.read(HINTS_SEEN_PREF, [], isStringArray));
  }

  isSeen(id: HintId): boolean {
    return this.seen.has(id);
  }

  markSeen(id: HintId): void {
    if (this.seen.has(id)) return;
    this.seen = new Set([...this.seen, id]);
    this.commit();
  }

  reset(): void {
    this.seen = new Set();
    this.commit();
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  getSnapshot = (): ReadonlySet<string> => this.seen;

  private commit(): void {
    this.prefs.write(HINTS_SEEN_PREF, [...this.seen]);
    for (const listener of this.listeners) listener();
  }
}

let instance: HintStore | null = null;

export function getHintStore(): HintStore {
  instance ??= new HintStore(getServices().prefs);
  return instance;
}

export function useHint(id: HintId): { visible: boolean; dismiss: () => void } {
  const store = getHintStore();
  const seen = useSyncExternalStore(store.subscribe, store.getSnapshot);
  return { visible: !seen.has(id), dismiss: () => store.markSeen(id) };
}
