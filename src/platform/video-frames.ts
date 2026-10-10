import { ALL_FORMATS, BlobSource, CanvasSink, Input, type InputVideoTrack, type WrappedCanvas } from "mediabunny";

/** Within this distance ahead of the last frame we keep iterating instead of re-seeking. */
export const FORWARD_ITERATION_WINDOW_SECONDS = 2;
/** Decoders (and the full frame each retains) kept open at once; the least recently used is closed beyond this. */
export const MAX_OPEN_DECODERS = 12;

export interface VideoFrameCacheOptions {
  /** Longest edge, in pixels, frames are decoded at. Larger sources are scaled down by the decoder. */
  maxEdge?: number;
}

class VideoSource {
  private input: Input<BlobSource> | null = null;
  private sink: CanvasSink | null = null;
  private iterator: AsyncGenerator<WrappedCanvas, void, unknown> | null = null;
  private last: WrappedCanvas | null = null;
  private ended = false;
  private chain: Promise<unknown> = Promise.resolve();

  lastUsed = 0;

  constructor(private readonly blob: Blob, private readonly maxEdge: number | undefined) {}

  get isOpen(): boolean {
    return this.input !== null;
  }

  private async open(): Promise<CanvasSink> {
    if (this.sink) return this.sink;
    const input = new Input({ source: new BlobSource(this.blob), formats: ALL_FORMATS });
    this.input = input;
    try {
      const track: InputVideoTrack | null = await input.getPrimaryVideoTrack();
      if (!track) throw new Error("Media has no video track");
      this.sink = new CanvasSink(track, await this.sizeOptions(track));
    } catch (error) {
      input.dispose();
      this.input = null;
      throw error;
    }
    return this.sink;
  }

  private async sizeOptions(track: InputVideoTrack): Promise<{ width: number; height: number; fit: "fill" } | undefined> {
    if (this.maxEdge === undefined) return undefined;
    const [width, height] = await Promise.all([track.getDisplayWidth(), track.getDisplayHeight()]);
    const scale = this.maxEdge / Math.max(width, height);
    if (!(scale < 1)) return undefined;
    return { width: Math.max(2, Math.round(width * scale)), height: Math.max(2, Math.round(height * scale)), fit: "fill" };
  }

  /** Calls are serialised per source: one iterator cannot serve two positions at once. */
  frameAt(seconds: number): Promise<WrappedCanvas | null> {
    const run = this.chain.then(() => this.read(seconds));
    this.chain = run.catch(() => undefined);
    return run;
  }

  private covers(frame: WrappedCanvas, t: number): boolean {
    return t >= frame.timestamp && t < frame.timestamp + frame.duration;
  }

  private async read(t: number): Promise<WrappedCanvas | null> {
    const sink = await this.open();
    const last = this.last;
    if (last && this.covers(last, t)) return last;

    const canIterate = last && this.iterator && !this.ended && t > last.timestamp && t - last.timestamp < FORWARD_ITERATION_WINDOW_SECONDS;
    if (canIterate && this.iterator) {
      while (true) {
        const next = await this.iterator.next();
        if (next.done) {
          this.ended = true;
          return this.last;
        }
        this.last = next.value;
        if (t < next.value.timestamp + next.value.duration) return next.value;
      }
    }

    await this.iterator?.return(undefined);
    const frame = await sink.getCanvas(t);
    this.last = frame;
    this.ended = false;
    this.iterator = frame ? sink.canvases(frame.timestamp) : null;
    if (this.iterator) await this.iterator.next();
    return frame;
  }

  async dispose(): Promise<void> {
    await this.chain.catch(() => undefined);
    await this.iterator?.return(undefined);
    this.iterator = null;
    this.input?.dispose();
    this.input = null;
    this.sink = null;
    this.last = null;
  }
}

/** Decoded video frames by media id and source time. Preview and export each own one. */
export class VideoFrameCache {
  private readonly sources = new Map<string, VideoSource>();
  private clock = 0;

  constructor(private readonly getBlob: (mediaId: string) => Blob | undefined, private readonly options: VideoFrameCacheOptions = {}) {}

  /** Number of decoders currently held open. */
  get openDecoders(): number {
    let open = 0;
    for (const source of this.sources.values()) if (source.isOpen) open++;
    return open;
  }

  async getFrame(mediaId: string, seconds: number): Promise<CanvasImageSource | null> {
    let source = this.sources.get(mediaId);
    if (!source) {
      const blob = this.getBlob(mediaId);
      if (!blob) return null;
      const evicted = this.evictToMakeRoom();
      source = new VideoSource(blob, this.options.maxEdge);
      source.lastUsed = ++this.clock;
      this.sources.set(mediaId, source);
      await evicted;
    }
    source.lastUsed = ++this.clock;
    const result = await source.frameAt(Math.max(0, seconds));
    return result ? (result.canvas as CanvasImageSource) : null;
  }

  /** Closes the least recently used decoders so that one more can be opened without exceeding the limit. */
  private async evictToMakeRoom(): Promise<void> {
    const evicted: Array<Promise<void>> = [];
    while (this.sources.size >= MAX_OPEN_DECODERS) {
      let oldest: [string, VideoSource] | null = null;
      for (const entry of this.sources) if (!oldest || entry[1].lastUsed < oldest[1].lastUsed) oldest = entry;
      if (!oldest) break;
      this.sources.delete(oldest[0]);
      evicted.push(oldest[1].dispose());
    }
    await Promise.all(evicted);
  }

  async release(mediaId: string): Promise<void> {
    const source = this.sources.get(mediaId);
    this.sources.delete(mediaId);
    await source?.dispose();
  }

  async dispose(): Promise<void> {
    const all = [...this.sources.values()];
    this.sources.clear();
    await Promise.all(all.map((s) => s.dispose()));
  }
}
