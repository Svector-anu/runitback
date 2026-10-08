import type { Editor } from "#/engine/editor";
import { SaveFailedError, type ProjectRepository } from "./types";

export type SaveStatus = "idle" | "dirty" | "saving" | "error";

export interface SaveState {
  status: SaveStatus;
  lastSavedAt: number | null;
  error: string | null;
}

export interface SaveManagerOptions {
  editor: Editor;
  repository: ProjectRepository;
  debounceMs?: number;
  /** Debounce for commits that only changed view state (scroll, zoom): they ride along with the next real save. */
  viewDebounceMs?: number;
  maxRetryMs?: number;
}

export const DEFAULT_AUTOSAVE_DEBOUNCE_MS = 800;
export const DEFAULT_VIEW_SAVE_DEBOUNCE_MS = 5_000;

/**
 * Debounced autosave. A failed save keeps the project dirty and retries with backoff, so a transient
 * storage error never silently drops edits. `flush` is the durable path: it waits for any in-flight save,
 * keeps saving until nothing is pending, and rejects if the final save fails.
 */
export class SaveManager {
  private state: SaveState = { status: "idle", lastSavedAt: null, error: null };
  private listeners = new Set<() => void>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private dirty = false;
  private viewOnly = false;
  private inflight: Promise<boolean> | null = null;
  private paused = false;
  private failures = 0;
  private unsubscribe: (() => void) | null = null;
  private seen: { doc: unknown; meta: unknown } | null = null;
  private readonly debounceMs: number;
  private readonly viewDebounceMs: number;
  private readonly maxRetryMs: number;

  constructor(private readonly options: SaveManagerOptions) {
    this.debounceMs = options.debounceMs ?? DEFAULT_AUTOSAVE_DEBOUNCE_MS;
    this.viewDebounceMs = options.viewDebounceMs ?? DEFAULT_VIEW_SAVE_DEBOUNCE_MS;
    this.maxRetryMs = options.maxRetryMs ?? 30_000;
  }

  getState = (): SaveState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private set(patch: Partial<SaveState>): void {
    this.state = { ...this.state, ...patch };
    for (const l of this.listeners) l();
  }

  private snapshotSeen(): { doc: unknown; meta: unknown } {
    const { doc, meta } = this.options.editor.getState();
    return { doc, meta };
  }

  start(): void {
    this.unsubscribe?.();
    this.seen = this.snapshotSeen();
    this.unsubscribe = this.options.editor.onCommitted(() => {
      const now = this.snapshotSeen();
      const viewOnly = this.seen !== null && now.doc === this.seen.doc && now.meta === this.seen.meta;
      this.seen = now;
      this.markDirty(viewOnly ? "view" : "content");
    });
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.clearTimer();
  }

  /** True while there are unsaved changes not yet durable, including a save that has started but not finished. */
  get isDirty(): boolean { return (this.dirty && !this.viewOnly) || this.inflight !== null; }

  /** Suppress saves while a project is loading. */
  pause(): void {
    this.paused = true;
    this.clearTimer();
  }

  resume(): void {
    this.paused = false;
    this.seen = this.snapshotSeen();
    if (this.dirty) this.schedule(this.debounceMs);
  }

  markDirty(kind: "content" | "view" = "content"): void {
    if (this.paused || !this.options.editor.hasProject) return;
    this.viewOnly = kind === "view" && (this.viewOnly || !this.dirty);
    this.dirty = true;
    if (kind === "content") {
      if (this.state.status !== "saving") this.set({ status: "dirty" });
      if (!this.inflight) this.schedule(this.debounceMs);
    } else if (!this.inflight && this.timer === null) {
      this.schedule(this.viewDebounceMs);
    }
  }

  private clearTimer(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  private schedule(ms: number): void {
    this.clearTimer();
    this.timer = setTimeout(() => void this.saveNow(), ms);
  }

  /**
   * Make every change committed so far durable. Waits for an in-flight save, then saves again until nothing
   * is pending, and rejects with `SaveFailedError` if a save fails (the project stays dirty and retrying).
   */
  async flush(): Promise<void> {
    this.clearTimer();
    for (;;) {
      if (this.inflight) await this.inflight;
      if (!this.dirty || this.paused || !this.options.editor.hasProject) return;
      const saved = await this.attempt();
      if (!saved) throw new SaveFailedError(this.state.error ?? "unknown error");
    }
  }

  async saveNow(): Promise<void> {
    this.clearTimer();
    if (this.inflight || !this.dirty || this.paused || !this.options.editor.hasProject) return;
    await this.attempt();
  }

  private attempt(): Promise<boolean> {
    const run = this.writeOnce().finally(() => { this.inflight = null; });
    this.inflight = run;
    return run;
  }

  private async writeOnce(): Promise<boolean> {
    this.dirty = false;
    this.viewOnly = false;
    this.set({ status: "saving" });
    try {
      await this.options.repository.save(this.options.editor.toProject());
    } catch (error) {
      this.dirty = true;
      this.failures++;
      this.set({ status: "error", error: error instanceof Error ? error.message : String(error) });
      this.schedule(Math.min(this.maxRetryMs, 1000 * 2 ** (this.failures - 1)));
      return false;
    }
    this.failures = 0;
    this.set({ status: this.dirty ? "dirty" : "idle", lastSavedAt: Date.now(), error: null });
    if (this.dirty) this.schedule(this.viewOnly ? this.viewDebounceMs : this.debounceMs);
    return true;
  }
}
