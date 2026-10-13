import { currentScene } from "#/engine/commands";
import { buildFramePlan, type FramePlan } from "#/engine/render";
import { lastFrameTime, frameIndexAt, mediaTime } from "#/engine/time";
import { totalDuration } from "#/engine/timeline";
import { Compositor } from "#/render/compositor";
import { getServices } from "./services";
import { sharedMaskProvider } from "#/platform/segmentation";

/** Renders the composition shown in the preview, coalescing requests and skipping frames that cannot have changed. */
export class PreviewRenderer {
  private readonly compositor: Compositor;
  private busy = false;
  private pending = false;
  private disposed = false;
  private lastKey: { doc: unknown; frame: number; runtime: unknown } | null = null;
  private readonly unsubscribe: Array<() => void> = [];
  lastPlan: FramePlan | null = null;
  onPlan: ((plan: FramePlan) => void) | null = null;

  constructor(readonly canvas: HTMLCanvasElement) {
    this.compositor = new Compositor(canvas);
    const { editor } = getServices();
    this.unsubscribe.push(editor.subscribe(() => this.request()), editor.playback.subscribe(() => this.request()));
    const onFonts = (): void => { this.lastKey = null; this.request(); };
    document.fonts?.addEventListener("loadingdone", onFonts);
    this.unsubscribe.push(() => document.fonts?.removeEventListener("loadingdone", onFonts));
    const masks = sharedMaskProvider();
    if (masks) this.unsubscribe.push(masks.subscribe(() => this.invalidate()));
    this.request();
  }

  request(): void {
    if (this.disposed) return;
    if (this.busy) {
      this.pending = true;
      return;
    }
    void this.run();
  }

  private async run(): Promise<void> {
    this.busy = true;
    try {
      do {
        this.pending = false;
        await this.renderOnce();
      } while (this.pending && !this.disposed);
    } catch (error) {
      console.error("Preview render failed", error);
    } finally {
      this.busy = false;
    }
  }

  private async renderOnce(): Promise<void> {
    const services = getServices();
    const { editor, runtime } = services;
    if (!editor.hasProject) return;
    const doc = editor.effectiveDoc();
    const tracks = currentScene(doc).tracks;
    const fps = doc.settings.fps;
    const duration = totalDuration(tracks);
    const time = Math.min(editor.playback.getState().currentTime, lastFrameTime(duration, fps));
    const frame = frameIndexAt(time, fps);
    if (this.lastKey && this.lastKey.doc === doc && this.lastKey.frame === frame && this.lastKey.runtime === runtime) return;
    this.lastKey = { doc, frame, runtime };
    const plan = buildFramePlan({ tracks, canvas: doc.settings.canvasSize, background: doc.settings.background, assets: doc.assets, time: mediaTime(time) });
    await this.compositor.render(plan, runtime.frameSources);
    this.lastPlan = plan;
    this.onPlan?.(plan);
  }

  invalidate(): void {
    this.lastKey = null;
    this.request();
  }

  dispose(): void {
    this.disposed = true;
    for (const off of this.unsubscribe) off();
  }
}
