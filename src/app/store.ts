import { useSyncExternalStore } from "react";

/** Minimal external store for UI-only state (never for document data). */
export class Store<T> {
  private listeners = new Set<() => void>();
  constructor(private state: T) {}

  get = (): T => this.state;

  set = (patch: Partial<T> | ((s: T) => Partial<T>)): void => {
    const next = typeof patch === "function" ? patch(this.state) : patch;
    this.state = { ...this.state, ...next };
    for (const l of this.listeners) l();
  };

  subscribe = (l: () => void): (() => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };

  use<S>(selector: (s: T) => S): S {
    return useSyncExternalStore(this.subscribe, () => selector(this.state));
  }
}
