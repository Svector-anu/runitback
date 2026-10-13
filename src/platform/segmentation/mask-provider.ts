import { maskAt, type MaskFrame, type MaskStore, type MaskTrack } from "#/engine/segmentation";

/**
 * Serves interpolated masks to the compositor. Tracks load from the store on first use (`ensure`, awaited by the
 * frame sources' prepare step) and are then read synchronously by the draw. `subscribe` fires when a track is added or
 * dropped so previews can redraw.
 */
export class MaskProvider {
  private readonly tracks = new Map<string, MaskTrack>();
  private readonly loading = new Map<string, Promise<void>>();
  private readonly listeners = new Set<() => void>();

  constructor(private readonly store: MaskStore) {}

  has(assetId: string): boolean {
    return this.tracks.has(assetId);
  }

  async ensure(assetId: string): Promise<void> {
    if (this.tracks.has(assetId)) return;
    let pending = this.loading.get(assetId);
    if (!pending) {
      pending = this.store.get(assetId).then((track) => {
        if (track) this.tracks.set(assetId, track);
      }).catch(() => undefined).finally(() => this.loading.delete(assetId));
      this.loading.set(assetId, pending);
    }
    await pending;
  }

  /** Keeps a freshly analysed track in memory and persists it. */
  async put(track: MaskTrack): Promise<void> {
    this.tracks.set(track.assetId, track);
    this.notify();
    await this.store.save(track);
  }

  async remove(assetId: string): Promise<void> {
    this.tracks.delete(assetId);
    this.notify();
    await this.store.delete(assetId);
  }

  /** The mask for a source instant, or null when the asset has not been analysed. */
  get(assetId: string, sourceSeconds: number): MaskFrame | null {
    const track = this.tracks.get(assetId);
    return track ? maskAt(track, sourceSeconds) : null;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}

let shared: MaskProvider | null = null;

/**
 * The app-wide provider. Preview, export, agent frame grabs and the bridge each build their own `CachedFrameSources`;
 * all of them read masks from here, so every renderer applies background removal identically (invariant 6).
 */
export function sharedMaskProvider(): MaskProvider | null {
  return shared;
}

export function setSharedMaskProvider(provider: MaskProvider | null): void {
  shared = provider;
}
