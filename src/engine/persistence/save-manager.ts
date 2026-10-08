import type { Editor } from "#/engine/editor";
import type { ProjectRepository } from "./types";

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
  maxRetryMs?: number;
}

export const DEFAULT_AUTOSAVE_DEBOUNCE_MS = 800;

/**
 * Debounced autosave. A failed save keeps the project dirty and retries with backoff, so a transient
 * storage error never silently drops edits.
 */
export class SaveManager {
  private state: SaveState = { status: "idle", lastSavedAt: null, error: null };
  private listeners = new Set<() => void>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private dirty = false;
  private saving = false;
  private paused = false;
  private failures = 0;
  private unsubscribe: (() => void) | null = null;
  private readonly debounceMs: number;
  private readonly maxRetryMs: number;

  constructor(private readonly options: SaveManagerOptions) {
    this.debounceMs = options.debounceMs ?? DEFAULT_AUTOSAVE_DEBOUNCE_MS;
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

  start(): void {
    this.unsubscribe?.();
    this.unsubscribe = this.options.editor.onCommitted(() => this.markDirty());
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.clearTimer();
  }

  get isDirty(): boolean { return this.dirty; }

  /** Suppress saves while a project is loading. */
  pause(): void {
    this.paused = true;
    this.clearTimer();
  }

  resume(): void {
    this.paused = false;
    if (this.dirty) this.schedule(this.debounceMs);
  }

  markDirty(): void {
    if (this.paused || !this.options.editor.hasProject) return;
    this.dirty = true;
    if (this.state.status !== "saving") this.set({ status: "dirty" });
    if (!this.saving) this.schedule(this.debounceMs);
  }

  private clearTimer(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  private schedule(ms: number): void {
    this.clearTimer();
    this.timer = setTimeout(() => void this.saveNow(), ms);
  }

  /** Save immediately (used when leaving the editor). Resolves once nothing is pending or the save failed. */
  async flush(): Promise<void> {
    this.clearTimer();
    await this.saveNow();
  }

  async saveNow(): Promise<void> {
    this.clearTimer();
    if (this.saving || !this.dirty || this.paused || !this.options.editor.hasProject) return;
    this.saving = true;
    this.dirty = false;
    this.set({ status: "saving" });
    try {
      await this.options.repository.save(this.options.editor.toProject());
      this.failures = 0;
      this.set({ status: this.dirty ? "dirty" : "idle", lastSavedAt: Date.now(), error: null });
    } catch (error) {
      this.dirty = true;
      this.failures++;
      this.set({ status: "error", error: error instanceof Error ? error.message : String(error) });
      this.saving = false;
      this.schedule(Math.min(this.maxRetryMs, 1000 * 2 ** (this.failures - 1)));
      return;
    }
    this.saving = false;
    if (this.dirty) this.schedule(this.debounceMs);
  }
}
