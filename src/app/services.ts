import { collectAudioClips } from "#/engine/audio";
import { Editor, type ExecuteResult } from "#/engine/editor";
import { currentScene } from "#/engine/commands";
import { removeAssetsCommand } from "#/engine/commands";
import { PROJECT_SCHEMA_VERSION, randomId, stringParam, type GeneratedProvenance, type MediaAssetInfo, type Project } from "#/engine/model";
import { buildFramePlan } from "#/engine/render";
import {
  ProjectLockedError, ProjectsService, SaveManager, StorageQuotaError, canStoreFile, isQuotaExceededError,
  type AssetRepository, type ProjectLockHandle, type ProjectLocks, type ProjectRepository,
} from "#/engine/persistence";
import { Compositor } from "#/render/compositor";
import { createCanvas } from "#/render/canvas";
import { AudioEngine } from "#/platform/audio-engine";
import { browserProjectLocks } from "#/platform/project-locks";
import { loadFont } from "#/platform/fonts";
import { MediaRuntime } from "#/platform/media-runtime";
import { PrefsStore } from "#/platform/prefs";
import { OpfsFileStore, StoragePersistence, estimateStorage, type StorageEstimate, type StorageManagerLike } from "#/platform/file-store";
import { exportProjectBundle, importProjectBundle, type BundleProgress, type ExportBundleResult, type ImportBundleResult } from "#/platform/bundle";
import { browserDerivedData } from "#/platform/derived-data-adapters";
import type { DerivedDataRegistry } from "#/platform/derived-data";
import { startPlaybackClock } from "./clock";
import { probeMedia, UnsupportedMediaError } from "#/platform/probe";
import type { Playback } from "#/engine/editor";
import type { AudioClip } from "#/engine/audio";
import type { AudioSinkCache } from "#/platform/audio-scheduler";
import { IdbMaskStore, MaskProvider, MemoryMaskStore, setSharedMaskProvider, sharedMaskProvider } from "#/platform/segmentation";
import { IdbAssetRepository, IdbProjectRepository, openAppDatabase } from "#/platform/repositories";

export interface ImportOutcome {
  imported: MediaAssetInfo[];
  failures: Array<{ name: string; message: string }>;
}

export const THUMBNAIL_WIDTH = 480;

export class ProjectNotFoundError extends Error {
  constructor(id: string) {
    super(`Project ${id} was not found`);
    this.name = "ProjectNotFoundError";
  }
}

export class ImportCanceledError extends Error {
  constructor() {
    super("Import canceled: the project was closed");
    this.name = "ImportCanceledError";
  }
}

export interface AudioEngineLike {
  attach(): void;
  restart(): void;
  dispose(): void;
}

export interface AppServicesDeps {
  projectRepository: ProjectRepository;
  assetRepository: AssetRepository;
  locks: ProjectLocks;
  storageMode: "opfs" | "indexeddb";
  derivedData: DerivedDataRegistry;
  /** `navigator.storage`; absent where the Storage API is missing. */
  storage?: StorageManagerLike;
  createRuntime: () => MediaRuntime;
  createAudioEngine: (deps: { playback: Playback; getClips: () => AudioClip[]; sinks: AudioSinkCache }) => AudioEngineLike;
  probe: typeof probeMedia;
}

function browserDeps(): AppServicesDeps {
  const db = openAppDatabase();
  const files = OpfsFileStore.isSupported() ? new OpfsFileStore() : null;
  return {
    projectRepository: new IdbProjectRepository(db),
    assetRepository: new IdbAssetRepository(db, files),
    locks: browserProjectLocks(),
    storageMode: files ? "opfs" : "indexeddb",
    derivedData: browserDerivedData(),
    ...(globalThis.navigator?.storage ? { storage: globalThis.navigator.storage } : {}),
    createRuntime: () => new MediaRuntime(),
    createAudioEngine: (deps) => new AudioEngine(deps),
    probe: probeMedia,
  };
}

/** One open project: everything that must be torn down together, and the identity imports register against. */
interface Session {
  readonly projectId: string;
  readonly runtime: MediaRuntime;
  readonly lock: ProjectLockHandle;
  accepting: boolean;
  stopAudio: () => void;
}

const ignore = (): void => undefined;

/** Composition root: wires storage, the editor engine, autosave and media decoding for the browser. */
export class AppServices {
  readonly prefs = new PrefsStore();
  readonly editor = new Editor({ newId: randomId, now: () => new Date().toISOString() });
  readonly projectRepository: ProjectRepository;
  readonly assetRepository: AssetRepository;
  readonly projects: ProjectsService;
  readonly saveManager: SaveManager;
  readonly storageMode: "opfs" | "indexeddb";
  readonly derivedData: DerivedDataRegistry;
  readonly persistence: StoragePersistence;
  runtime: MediaRuntime;
  private session: Session | null = null;
  private chain: Promise<unknown> = Promise.resolve();
  private readonly exports = new Set<AbortController>();
  private pendingRepairs: { projectId: string; notes: string[] } = { projectId: "", notes: [] };
  private readonly deps: AppServicesDeps;

  constructor(deps: AppServicesDeps = browserDeps()) {
    this.deps = deps;
    this.storageMode = deps.storageMode;
    this.derivedData = deps.derivedData;
    this.persistence = new StoragePersistence({ storage: deps.storage, prefs: this.prefs });
    if (!sharedMaskProvider()) setSharedMaskProvider(new MaskProvider(typeof indexedDB === "undefined" ? new MemoryMaskStore() : new IdbMaskStore()));
    this.runtime = deps.createRuntime();
    this.projectRepository = deps.projectRepository;
    this.assetRepository = deps.assetRepository;
    this.projects = new ProjectsService({
      projects: this.projectRepository, assets: this.assetRepository, newId: randomId, now: () => new Date().toISOString(),
      locks: deps.locks, derived: deps.derivedData,
    });
    this.saveManager = new SaveManager({ editor: this.editor, repository: this.projectRepository });
    this.saveManager.start();
    this.saveManager.subscribe(() => {
      if (this.saveManager.getState().lastSavedAt !== null) void this.persistence.requestOnce();
    });
    startPlaybackClock(this.editor.playback);
  }

  get currentProjectId(): string | null {
    return this.session?.projectId ?? null;
  }

  /** Registers a running export so closing the project cancels it. Returns the unregister function. */
  trackExport(controller: AbortController): () => void {
    this.exports.add(controller);
    return () => void this.exports.delete(controller);
  }

  /** Open, close and every other lifecycle step run strictly one after another, in call order. */
  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.chain.then(task);
    this.chain = run.then(ignore, ignore);
    return run;
  }

  openProject(id: string): Promise<void> {
    return this.enqueue(() => this.openNow(id));
  }

  closeProject(): Promise<void> {
    return this.enqueue(() => this.closeNow());
  }

  private async openNow(id: string): Promise<void> {
    if (this.session?.projectId === id && this.editor.hasProject) return;
    await this.closeNow();
    const lock = await this.deps.locks.tryAcquire(id);
    if (!lock) throw new ProjectLockedError(id);
    this.saveManager.pause();
    try {
      const project = await this.projectRepository.load(id);
      if (!project) throw new ProjectNotFoundError(id);
      const stored = await this.projects.loadAssets(project);
      const runtime = this.deps.createRuntime();
      const available: MediaAssetInfo[] = [];
      for (const info of stored) {
        const blob = await this.assetRepository.getFile(id, info.id);
        if (blob) {
          runtime.setBlob(info.id, blob);
          available.push(info);
        }
      }
      this.runtime = runtime;
      this.editor.load({ project, assets: available });
      if (project.repairNotes?.length) this.pendingRepairs = { projectId: id, notes: project.repairNotes };
      else if (this.pendingRepairs.projectId !== id) this.pendingRepairs = { projectId: id, notes: [] };
      this.session = { projectId: id, runtime, lock, accepting: true, stopAudio: this.startAudio(runtime) };
      void this.preloadFonts(project);
    } catch (error) {
      lock.release();
      throw error;
    } finally {
      this.saveManager.resume();
    }
    if (this.pendingRepairs.projectId === id && this.pendingRepairs.notes.length > 0) this.saveManager.markDirty("content");
  }

  /**
   * Problems repaired while the current project loaded; returned once so the UI reports them a single time. The notes
   * survive a close/reopen of the same project (React StrictMode, quick navigation) because the first open already saved the fix.
   */
  takeRepairNotes(): string[] {
    const { notes } = this.pendingRepairs;
    this.pendingRepairs = { projectId: this.pendingRepairs.projectId, notes: [] };
    return notes;
  }

  /** Returns the teardown for this project's audio: its commit listener and its engine. */
  private startAudio(runtime: MediaRuntime): () => void {
    const engine = this.deps.createAudioEngine({
      playback: this.editor.playback,
      getClips: () => {
        const doc = this.editor.effectiveDoc();
        return collectAudioClips({ tracks: currentScene(doc).tracks, assets: doc.assets });
      },
      sinks: runtime.audio,
    });
    engine.attach();
    let lastDoc = this.editor.getState().doc;
    const unsubscribe = this.editor.onCommitted(() => {
      const doc = this.editor.getState().doc;
      if (doc === lastDoc) return;
      lastDoc = doc;
      if (this.editor.playback.getState().isPlaying) engine.restart();
    });
    return () => {
      unsubscribe();
      engine.dispose();
    };
  }

  private async preloadFonts(project: Project): Promise<void> {
    const families = new Set<string>();
    for (const scene of project.scenes) {
      for (const track of [...scene.tracks.overlay, scene.tracks.main]) {
        for (const el of track.elements) if (el.type === "text") families.add(stringParam(el.params, "fontFamily", "Arial"));
      }
    }
    await Promise.all([...families].map((f) => loadFont(f)));
  }

  /**
   * Makes every edit durable, sweeps orphaned media, then releases the project. If the edits cannot be saved
   * this rejects and the project stays open (and keeps retrying) rather than discarding unsaved work.
   */
  private async closeNow(): Promise<void> {
    const session = this.session;
    if (!session || !this.editor.hasProject) return;
    this.editor.playback.pause();
    session.accepting = false;
    try {
      await this.saveManager.flush();
    } catch (error) {
      session.accepting = true;
      throw error;
    }
    for (const controller of this.exports) controller.abort();
    try {
      await this.updateThumbnail();
      await this.saveManager.flush();
    } catch (error) {
      console.warn("Could not refresh the project thumbnail", error);
    }
    try {
      await this.projects.finalizeClose({ projectId: session.projectId, registeredAssetIds: this.editor.getState().doc.assets.map((a) => a.id) });
    } catch (error) {
      console.warn("Could not sweep unused media", error);
    }
    session.stopAudio();
    this.editor.close();
    this.session = null;
    await session.runtime.dispose();
    this.runtime = this.deps.createRuntime();
    session.lock.release();
  }

  /** Packs a stored project (media, derived data) into one `.runitback` file. Works on what is saved, not on the open document. */
  exportProject(id: string, options: BundleOptions & { includeEmbeddings?: boolean } = {}): Promise<ExportBundleResult> {
    return exportProjectBundle(
      { projects: this.projectRepository, assets: this.assetRepository, derived: this.derivedData, now: () => new Date().toISOString(), createdWith: `RunItBack (project schema v${PROJECT_SCHEMA_VERSION})` },
      { projectId: id, includeEmbeddings: options.includeEmbeddings ?? false, ...(options.onProgress ? { onProgress: options.onProgress } : {}), ...(options.signal ? { signal: options.signal } : {}) },
    );
  }

  /** Imports a `.runitback` file as a new project with fresh ids. */
  async importProject(file: Blob, options: BundleOptions = {}): Promise<ImportBundleResult> {
    const result = await importProjectBundle(
      { projects: this.projectRepository, assets: this.assetRepository, derived: this.derivedData, newId: randomId, now: () => new Date().toISOString(), ...(this.deps.storage ? { storage: this.deps.storage } : {}) },
      file, { ...(options.onProgress ? { onProgress: options.onProgress } : {}), ...(options.signal ? { signal: options.signal } : {}) },
    );
    void this.persistence.requestOnce();
    return result;
  }

  storageEstimate(): Promise<StorageEstimate | null> {
    return estimateStorage(this.deps.storage);
  }

  /** The one-time "storage may be cleared" message, if the browser refused durable storage and the user has not yet been told. */
  takeStorageNotice(): Promise<string | null> {
    return this.persistence.takeNotice();
  }

  /** Deletes derived data whose media no project stores any more (failed purges, jobs that finished after their media was removed). */
  purgeStrayDerivedData(): Promise<string[]> {
    return this.projects.purgeStrayDerived();
  }

  async updateThumbnail(): Promise<void> {
    if (!this.editor.hasProject) return;
    const doc = this.editor.getState().doc;
    const tracks = currentScene(doc).tracks;
    const size = doc.settings.canvasSize;
    const canvas = createCanvas(size.width, size.height);
    const compositor = new Compositor(canvas);
    const plan = buildFramePlan({ tracks, canvas: size, background: doc.settings.background, assets: doc.assets, time: 0 });
    await compositor.render(plan, this.runtime.frameSources);
    const scaled = createCanvas(THUMBNAIL_WIDTH, Math.round((THUMBNAIL_WIDTH * size.height) / size.width));
    scaled.getContext("2d")?.drawImage(canvas as CanvasImageSource, 0, 0, scaled.width, scaled.height);
    const blob = scaled instanceof OffscreenCanvas
      ? await scaled.convertToBlob({ type: "image/jpeg", quality: 0.8 })
      : await new Promise<Blob | null>((resolve) => (scaled as HTMLCanvasElement).toBlob(resolve, "image/jpeg", 0.8));
    if (!blob) return;
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
    this.editor.updateMetadata({ thumbnail: dataUrl });
  }

  /**
   * Probe, store and register files into the project that was open when the import started. Every failure is
   * reported per file; successes are kept. If that project closes mid-import, remaining files are abandoned and
   * any bytes already stored for the closed project are removed again.
   */
  async importFiles(files: ReadonlyArray<File>, onProgress?: (done: number, total: number) => void, options: { generated?: GeneratedProvenance } = {}): Promise<ImportOutcome> {
    const session = this.session;
    if (!session?.accepting) throw new Error("No project is open");
    const { projectId, runtime } = session;
    const live = (): boolean => this.session === session && session.accepting;
    const outcome: ImportOutcome = { imported: [], failures: [] };
    let done = 0;
    for (const file of files) {
      try {
        const probed = await this.deps.probe(file, randomId());
        const info = options.generated ? { ...probed, generated: options.generated } : probed;
        const estimate = await globalThis.navigator?.storage?.estimate?.().catch(() => undefined);
        const decision = canStoreFile({ size: file.size, usage: estimate?.usage, quota: estimate?.quota });
        if (!decision.canStore) throw new StorageQuotaError();
        if (!live()) throw new ImportCanceledError();
        await this.assetRepository.save(projectId, { info, file });
        if (!live()) {
          await this.assetRepository.remove(projectId, info.id).catch(ignore);
          throw new ImportCanceledError();
        }
        runtime.setBlob(info.id, file);
        this.editor.registerAsset(info);
        outcome.imported.push(info);
      } catch (error) {
        if (error instanceof ImportCanceledError) {
          outcome.failures.push({ name: file.name, message: error.message });
          break;
        }
        const message = error instanceof UnsupportedMediaError || error instanceof StorageQuotaError || isQuotaExceededError(error)
          ? (error as Error).message
          : `Could not import ${file.name}: ${error instanceof Error ? error.message : String(error)}`;
        outcome.failures.push({ name: file.name, message });
      }
      onProgress?.(++done, files.length);
    }
    return outcome;
  }

  /**
   * Removing media is one undoable step; stored bytes, and the analysis/transcript/embedding/face data derived from them,
   * stay until the project closes and `ProjectsService.sweepOrphans` deletes the bytes, so undo can restore everything.
   */
  removeAssets(ids: ReadonlyArray<string>): ExecuteResult {
    const result = this.editor.tryExecute(removeAssetsCommand(ids));
    if (result.ok) for (const id of ids) void (this.session?.runtime ?? this.runtime).video.release(id);
    return result;
  }
}

export interface BundleOptions {
  onProgress?: (progress: BundleProgress) => void;
  signal?: AbortSignal;
}

let instance: AppServices | null = null;

export function getServices(): AppServices {
  instance ??= new AppServices();
  return instance;
}
