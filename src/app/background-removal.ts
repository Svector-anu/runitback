import { maskCoverage, type MaskTrack } from "#/engine/segmentation";
import { MaskProvider, IdbMaskStore, MemoryMaskStore, createSegmentationIndexer, setSharedMaskProvider, sharedMaskProvider } from "#/platform/segmentation";
import { Store } from "./store";
import { getServices } from "./services";

export interface BackgroundJobView {
  /** 0..1 */
  progress: number;
}

export interface BackgroundState {
  jobs: Readonly<Record<string, BackgroundJobView>>;
  /** Last failure per asset in this session. */
  errors: Readonly<Record<string, string>>;
  /** Assets with usable masks in memory or storage, bumped whenever one is added or dropped. */
  version: number;
}

const without = <T>(record: Readonly<Record<string, T>>, key: string): Record<string, T> => {
  const next = { ...record };
  delete next[key];
  return next;
};

/**
 * Background-removal analysis for the app: one job per asset at a time, progress and cancel, masks kept in the shared
 * `MaskProvider` that every renderer (preview, export, frame grabs) reads from.
 */
export class BackgroundRemovalService {
  readonly state = new Store<BackgroundState>({ jobs: {}, errors: {}, version: 0 });
  private readonly controllers = new Map<string, AbortController>();
  private readonly running = new Map<string, Promise<MaskTrack>>();

  constructor(readonly provider: MaskProvider, private readonly indexer = createSegmentationIndexer()) {
    provider.subscribe(() => this.state.set((s) => ({ version: s.version + 1 })));
  }

  async isReady(assetId: string): Promise<boolean> {
    await this.provider.ensure(assetId);
    return this.provider.has(assetId);
  }

  /** Segments the asset (reusing a running job for it). Rejects with an `AbortError` when cancelled. */
  analyze(assetId: string, options: { signal?: AbortSignal } = {}): Promise<MaskTrack> {
    const existing = this.running.get(assetId);
    if (existing) return existing;
    const { editor, runtime } = getServices();
    const asset = editor.getAsset(assetId);
    const blob = runtime.getBlob(assetId);
    if (!asset || !blob) return Promise.reject(new Error(`Media for asset ${assetId} is not loaded`));
    if (asset.type === "audio") return Promise.reject(new Error("Background removal needs a video or image"));
    const controller = new AbortController();
    this.controllers.set(assetId, controller);
    options.signal?.addEventListener("abort", () => controller.abort(), { once: true });
    this.state.set((s) => ({ jobs: { ...s.jobs, [assetId]: { progress: 0 } }, errors: without(s.errors, assetId) }));
    const job = this.indexer.index({
      assetId, blob, kind: asset.type, width: asset.width ?? 1280, height: asset.height ?? 720,
      durationSeconds: (asset.duration ?? 0) / 120_000, ...(asset.fps ? { fps: asset.fps.numerator / asset.fps.denominator } : {}),
      signal: controller.signal,
      onProgress: (progress) => this.state.set((s) => ({ jobs: { ...s.jobs, [assetId]: { progress } } })),
    }).then(async (track) => {
      await this.provider.put(track);
      return track;
    }).catch((error: unknown) => {
      if (!controller.signal.aborted) this.state.set((s) => ({ errors: { ...s.errors, [assetId]: error instanceof Error ? error.message : String(error) } }));
      throw error;
    }).finally(() => {
      this.controllers.delete(assetId);
      this.running.delete(assetId);
      this.state.set((s) => ({ jobs: without(s.jobs, assetId) }));
    });
    this.running.set(assetId, job);
    return job;
  }

  cancel(assetId: string): void {
    this.controllers.get(assetId)?.abort();
  }

  /** Share of sampled frames in which a person covers at least 2% of the picture, and the frame count. */
  summarize(track: MaskTrack): { frames: number; personShare: number } {
    const present = track.frames.filter((data) => maskCoverage({ width: track.width, height: track.height, data }) >= 0.02).length;
    return { frames: track.frames.length, personShare: present / track.frames.length };
  }
}

let service: BackgroundRemovalService | null = null;

/** Creates the service and registers its provider as the shared one every renderer reads. Safe to call repeatedly. */
export function getBackgroundRemoval(): BackgroundRemovalService {
  if (!service) {
    const existing = sharedMaskProvider();
    const provider = existing ?? new MaskProvider(typeof indexedDB === "undefined" ? new MemoryMaskStore() : new IdbMaskStore());
    if (!existing) setSharedMaskProvider(provider);
    service = new BackgroundRemovalService(provider);
  }
  return service;
}

/** Starts analysing the media behind a clip right after background removal was added to it; failures show in the effect card. */
export function startBackgroundAnalysis(assetId: string): void {
  const service = getBackgroundRemoval();
  void service.isReady(assetId).then((ready) => (ready ? undefined : service.analyze(assetId))).catch(() => undefined);
}
