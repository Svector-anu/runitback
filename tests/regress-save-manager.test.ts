import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryProjectRepository, SaveFailedError, SaveManager } from "#/engine/persistence";
import type { Project } from "#/engine/model";
import { makeEditor } from "./helpers";

class SlowRepository extends MemoryProjectRepository {
  readonly saved: string[] = [];
  gate: Promise<void> | null = null;
  override async save(project: Project): Promise<void> {
    if (this.gate) await this.gate;
    this.saved.push(project.metadata.name);
    await super.save(project);
  }
}

const rename = (editor: ReturnType<typeof makeEditor>["editor"], name: string): void => editor.updateMetadata({ name });

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("P0-4 SaveManager.flush", () => {
  it("waits for an in-flight save and also persists the edit made during it", async () => {
    const { editor } = makeEditor();
    const repo = new SlowRepository();
    let release!: () => void;
    repo.gate = new Promise<void>((r) => { release = r; });
    const manager = new SaveManager({ editor, repository: repo });
    manager.start();

    rename(editor, "first");
    await vi.advanceTimersByTimeAsync(800);
    expect(manager.getState().status).toBe("saving");
    rename(editor, "second");

    let flushed = false;
    const flushing = manager.flush().then(() => { flushed = true; });
    await vi.advanceTimersByTimeAsync(0);
    expect(flushed).toBe(false);
    repo.gate = null;
    release();
    await flushing;

    expect(repo.saved.at(-1)).toBe("second");
    expect((await repo.load("p1"))?.metadata.name).toBe("second");
    expect(manager.isDirty).toBe(false);
  });

  it("rejects when the final save fails instead of reporting success", async () => {
    const { editor } = makeEditor();
    const repo = new MemoryProjectRepository();
    repo.failNextSaves = 5;
    const manager = new SaveManager({ editor, repository: repo });
    manager.start();
    rename(editor, "unsaved");
    await expect(manager.flush()).rejects.toBeInstanceOf(SaveFailedError);
    expect(manager.isDirty).toBe(true);
  });

  it("counts a save in flight as unsaved for the beforeunload guard", async () => {
    const { editor } = makeEditor();
    const repo = new SlowRepository();
    repo.gate = new Promise<void>(() => undefined);
    const manager = new SaveManager({ editor, repository: repo });
    manager.start();
    rename(editor, "x");
    await vi.advanceTimersByTimeAsync(800);
    expect(manager.isDirty).toBe(true);
  });
});

describe("P1-4 view-state commits", () => {
  it("do not trigger a project write at the normal autosave delay", async () => {
    const { editor } = makeEditor();
    const repo = new MemoryProjectRepository();
    const manager = new SaveManager({ editor, repository: repo });
    manager.start();
    editor.setViewState({ scrollLeft: 400 });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(repo.saveCount).toBe(0);
    expect(manager.getState().status).not.toBe("dirty");
    expect(manager.isDirty).toBe(false);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(repo.saveCount).toBe(1);
  });

  it("still save promptly when a real edit follows", async () => {
    const { editor } = makeEditor();
    const repo = new MemoryProjectRepository();
    const manager = new SaveManager({ editor, repository: repo });
    manager.start();
    editor.setViewState({ zoomLevel: 3 });
    rename(editor, "real");
    await vi.advanceTimersByTimeAsync(800);
    expect(repo.saveCount).toBe(1);
  });
});
