import { AudioSinkCache } from "./audio-scheduler";
import { CachedFrameSources, ImageCache } from "./frame-sources";
import { VideoFrameCache } from "./video-frames";
import { WaveformCache } from "./waveform";

/** Longest edge preview frames are decoded at; a 4K source costs a quarter of the memory per frame. */
export const PREVIEW_MAX_EDGE = 1920;

export interface MediaRuntimeStats {
  blobs: number;
  objectUrls: number;
  videoDecoders: number;
  imageBitmaps: number;
}

/**
 * Everything decoded or derived from a project's media files. One instance per open project;
 * `dispose` releases decoders, bitmaps and object URLs so nothing outlives the project.
 */
export class MediaRuntime {
  private readonly blobs = new Map<string, Blob>();
  private readonly urls = new Map<string, string>();
  readonly video = new VideoFrameCache((id) => this.blobs.get(id), { maxEdge: PREVIEW_MAX_EDGE });
  readonly images = new ImageCache((id) => this.blobs.get(id));
  readonly audio = new AudioSinkCache((id) => this.blobs.get(id));
  readonly waveforms = new WaveformCache(this.audio);
  readonly frameSources = new CachedFrameSources(this.video, this.images);

  /** Live resource counts, so tests and diagnostics can assert nothing outlives its owner. */
  stats(): MediaRuntimeStats {
    return { blobs: this.blobs.size, objectUrls: this.urls.size, videoDecoders: this.video.openDecoders, imageBitmaps: this.images.size };
  }

  setBlob(mediaId: string, blob: Blob): void {
    this.blobs.set(mediaId, blob);
  }

  getBlob = (mediaId: string): Blob | undefined => this.blobs.get(mediaId);

  has(mediaId: string): boolean {
    return this.blobs.has(mediaId);
  }

  objectUrl(mediaId: string): string | null {
    const existing = this.urls.get(mediaId);
    if (existing) return existing;
    const blob = this.blobs.get(mediaId);
    if (!blob) return null;
    const url = URL.createObjectURL(blob);
    this.urls.set(mediaId, url);
    return url;
  }

  async release(mediaId: string): Promise<void> {
    this.blobs.delete(mediaId);
    const url = this.urls.get(mediaId);
    if (url) URL.revokeObjectURL(url);
    this.urls.delete(mediaId);
    this.waveforms.release(mediaId);
    await Promise.all([this.video.release(mediaId), this.images.release(mediaId), this.audio.release(mediaId)]);
  }

  async dispose(): Promise<void> {
    for (const url of this.urls.values()) URL.revokeObjectURL(url);
    this.urls.clear();
    this.waveforms.clear();
    await Promise.all([this.video.dispose(), this.images.dispose(), this.audio.dispose()]);
    this.blobs.clear();
  }
}
