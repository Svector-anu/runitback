import { collectAudioClips } from "#/engine/audio";
import { Editor } from "#/engine/editor";
import { currentScene } from "#/engine/commands";
import { removeAssetsCommand } from "#/engine/commands";
import { randomId, stringParam, type MediaAssetInfo, type Project } from "#/engine/model";
import { buildFramePlan } from "#/engine/render";
import {
  ProjectsService, SaveManager, StorageQuotaError, canStoreFile, isQuotaExceededError,
} from "#/engine/persistence";
import { Compositor } from "#/render/compositor";
import { createCanvas } from "#/render/canvas";
import { AudioEngine } from "#/platform/audio-engine";
import { loadFont } from "#/platform/fonts";
import { OpfsFileStore } from "#/platform/file-store";
import { MediaRuntime } from "#/platform/media-runtime";
import { PrefsStore } from "#/platform/prefs";
import { startPlaybackClock } from "./clock";
import { probeMedia, UnsupportedMediaError } from "#/platform/probe";
import { IdbAssetRepository, IdbProjectRepository, openOpenCutDatabase } from "#/platform/repositories";

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

/** Composition root: wires storage, the editor engine, autosave and media decoding for the browser. */
export class AppServices {
  readonly prefs = new PrefsStore();
  readonly editor = new Editor({ newId: randomId, now: () => new Date().toISOString() });
  readonly projectRepository: IdbProjectRepository;
  readonly assetRepository: IdbAssetRepository;
  readonly projects: ProjectsService;
  readonly saveManager: SaveManager;
  readonly storageMode: "opfs" | "indexeddb";
  runtime = new MediaRuntime();
  private audioEngine: AudioEngine | null = null;
  private openProjectId: string | null = null;

  constructor() {
    const db = openOpenCutDatabase();
    const files = OpfsFileStore.isSupported() ? new OpfsFileStore() : null;
    this.storageMode = files ? "opfs" : "indexeddb";
    this.projectRepository = new IdbProjectRepository(db);
    this.assetRepository = new IdbAssetRepository(db, files);
    this.projects = new ProjectsService({
      projects: this.projectRepository, assets: this.assetRepository, newId: randomId, now: () => new Date().toISOString(),
    });
    this.saveManager = new SaveManager({ editor: this.editor, repository: this.projectRepository });
    this.saveManager.start();
    startPlaybackClock(this.editor.playback);
  }

  get currentProjectId(): string | null {
    return this.openProjectId;
  }

  async openProject(id: string): Promise<void> {
    if (this.openProjectId === id && this.editor.hasProject) return;
    await this.closeProject();
    this.saveManager.pause();
    try {
      const project = await this.projectRepository.load(id);
      if (!project) throw new ProjectNotFoundError(id);
      const stored = await this.projects.loadAssets(project);
      const runtime = new MediaRuntime();
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
      this.openProjectId = id;
      this.startAudio();
      void this.preloadFonts(project);
    } finally {
      this.saveManager.resume();
    }
  }

  private startAudio(): void {
    this.audioEngine?.dispose();
    const engine = new AudioEngine({
      playback: this.editor.playback,
      getClips: () => {
        const doc = this.editor.effectiveDoc();
        return collectAudioClips({ tracks: currentScene(doc).tracks, assets: doc.assets });
      },
      sinks: this.runtime.audio,
    });
    engine.attach();
    this.audioEngine = engine;
    this.editor.onCommitted(() => {
      if (this.editor.playback.getState().isPlaying) engine.restart();
    });
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

  /** Saves, renders a thumbnail, sweeps orphaned media, and releases every decoder. */
  async closeProject(): Promise<void> {
    if (!this.openProjectId || !this.editor.hasProject) return;
    this.editor.playback.pause();
    try {
      await this.updateThumbnail();
      await this.saveManager.flush();
      await this.projects.collectOrphans(this.editor.toProject());
    } catch (error) {
      console.error("Could not finish saving the project", error);
    }
    this.audioEngine?.dispose();
    this.audioEngine = null;
    this.editor.close();
    await this.runtime.dispose();
    this.runtime = new MediaRuntime();
    this.openProjectId = null;
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

  /** Probe, store and register files. Every failure is reported per file; successes are kept. */
  async importFiles(files: ReadonlyArray<File>, onProgress?: (done: number, total: number) => void): Promise<ImportOutcome> {
    const projectId = this.openProjectId;
    if (!projectId) throw new Error("No project is open");
    const outcome: ImportOutcome = { imported: [], failures: [] };
    let done = 0;
    for (const file of files) {
      try {
        const info = await probeMedia(file, randomId());
        const estimate = await navigator.storage?.estimate?.().catch(() => undefined);
        const decision = canStoreFile({ size: file.size, usage: estimate?.usage, quota: estimate?.quota });
        if (!decision.canStore) throw new StorageQuotaError();
        await this.assetRepository.save(projectId, { info, file });
        this.runtime.setBlob(info.id, file);
        this.editor.registerAsset(info);
        outcome.imported.push(info);
      } catch (error) {
        const message = error instanceof UnsupportedMediaError || error instanceof StorageQuotaError || isQuotaExceededError(error)
          ? (error as Error).message
          : `Could not import ${file.name}: ${error instanceof Error ? error.message : String(error)}`;
        outcome.failures.push({ name: file.name, message });
      }
      onProgress?.(++done, files.length);
    }
    return outcome;
  }

  /** Removing media is one undoable step; stored bytes stay until the project closes so undo can restore them. */
  removeAssets(ids: ReadonlyArray<string>): void {
    this.editor.execute(removeAssetsCommand(ids));
    for (const id of ids) void this.runtime.video.release(id);
  }
}

let instance: AppServices | null = null;

export function getServices(): AppServices {
  instance ??= new AppServices();
  return instance;
}
