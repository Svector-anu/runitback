import { ALL_FORMATS, BlobSource, CanvasSink, Input, type InputVideoTrack, type WrappedCanvas } from "mediabunny";

/** Within this distance ahead of the last frame we keep iterating instead of re-seeking. */
export const FORWARD_ITERATION_WINDOW_SECONDS = 2;

class VideoSource {
  private input: Input<BlobSource> | null = null;
  private sink: CanvasSink | null = null;
  private iterator: AsyncGenerator<WrappedCanvas, void, unknown> | null = null;
  private last: WrappedCanvas | null = null;
  private ended = false;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly blob: Blob) {}

  private async open(): Promise<CanvasSink> {
    if (this.sink) return this.sink;
    this.input = new Input({ source: new BlobSource(this.blob), formats: ALL_FORMATS });
    const track: InputVideoTrack | null = await this.input.getPrimaryVideoTrack();
    if (!track) throw new Error("Media has no video track");
    this.sink = new CanvasSink(track);
    return this.sink;
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

  constructor(private readonly getBlob: (mediaId: string) => Blob | undefined) {}

  async getFrame(mediaId: string, seconds: number): Promise<CanvasImageSource | null> {
    let source = this.sources.get(mediaId);
    if (!source) {
      const blob = this.getBlob(mediaId);
      if (!blob) return null;
      source = new VideoSource(blob);
      this.sources.set(mediaId, source);
    }
    const frame = await source.frameAt(Math.max(0, seconds));
    return frame ? (frame.canvas as CanvasImageSource) : null;
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
