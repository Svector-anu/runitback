import { numberParam, type BlendMode } from "#/engine/model";
import type { DrawItem, FramePlan, LayerSource, MediaLayer, ResolvedEffect, TextLayer } from "#/engine/render";
import { adjustPlan, applyChromaKey, blurSigma, chromaKeyIsNoop, chromaKeyPlan, transitionLook, type AdjustPlan, type ChromaKeyPlan } from "#/engine/render";
import type { MaskFrame } from "#/engine/segmentation";
import { ChromaKeyGpu } from "./chroma-gpu";
import { MaskRasterizer } from "./segmentation";
import { context2d, createCanvas, resizeCanvas, type AnyCanvas, type AnyContext } from "./canvas";
import { GraphicCache, isSizedGraphic } from "./graphics";
import { isInverted, renderMask, renderMaskStroke } from "./masks";
import { drawText } from "./text";

/** Supplies pixels for media layers; rendering is two-phase so decoding can be awaited before drawing. */
export interface FrameSources {
  prepare(plan: FramePlan): Promise<void>;
  get(source: Extract<LayerSource, { type: "video" | "image" }>): CanvasImageSource | null;
  /** Person mask for the clip's source frame (background removal); null when the media has not been analysed. */
  mask?(source: Extract<LayerSource, { type: "video" | "image" }>): MaskFrame | null;
}

const COMPOSITE: Record<BlendMode, GlobalCompositeOperation> = {
  normal: "source-over", darken: "darken", multiply: "multiply", "color-burn": "color-burn", lighten: "lighten",
  screen: "screen", "plus-lighter": "lighter", "color-dodge": "color-dodge", overlay: "overlay", "soft-light": "soft-light",
  "hard-light": "hard-light", difference: "difference", exclusion: "exclusion", hue: "hue", saturation: "saturation",
  color: "color", luminosity: "luminosity",
};

export function compositeOperation(mode: BlendMode): GlobalCompositeOperation {
  return COMPOSITE[mode];
}

function imageSize(image: CanvasImageSource): { width: number; height: number } {
  const sized = image as { width?: number; height?: number; displayWidth?: number; displayHeight?: number; videoWidth?: number; videoHeight?: number };
  return {
    width: sized.displayWidth ?? sized.videoWidth ?? (typeof sized.width === "number" ? sized.width : 1),
    height: sized.displayHeight ?? sized.videoHeight ?? (typeof sized.height === "number" ? sized.height : 1),
  };
}

export type ChromaBackend = "auto" | "gpu" | "cpu";

export interface CompositorOptions {
  /** `auto` uses WebGL2 when it initialises and the CPU pass otherwise; `cpu`/`gpu` pin one for tests and measurements. */
  chromaBackend?: ChromaBackend;
}

interface EffectGeometry { width: number; height: number; centerX: number; centerY: number }

/** Canvas2D implementation of the frame plan. A GPU/WASM compositor can replace it behind the same call. */
export class Compositor {
  private readonly ctx: AnyContext;
  private layer: AnyCanvas;
  private layerCtx: AnyContext;
  private scratch: AnyCanvas;
  private scratchCtx: AnyContext;
  private scratch2: AnyCanvas;
  private scratch2Ctx: AnyContext;
  private readonly graphics = new GraphicCache();
  private readonly masks = new MaskRasterizer();

  private chromaGpu: ChromaKeyGpu | null | undefined;
  /** Which implementation ran the most recent chroma key; null until one has run. */
  lastChromaBackend: "gpu" | "cpu" | null = null;

  constructor(readonly canvas: AnyCanvas, private readonly options: CompositorOptions = {}) {
    this.ctx = context2d(canvas);
    this.layer = createCanvas(canvas.width, canvas.height);
    this.layerCtx = context2d(this.layer);
    this.scratch = createCanvas(canvas.width, canvas.height);
    this.scratchCtx = context2d(this.scratch);
    this.scratch2 = createCanvas(canvas.width, canvas.height);
    this.scratch2Ctx = context2d(this.scratch2);
  }

  setSize(width: number, height: number): void {
    if (this.canvas.width === width && this.canvas.height === height) return;
    resizeCanvas(this.canvas, width, height);
    resizeCanvas(this.layer, width, height);
    resizeCanvas(this.scratch, width, height);
    resizeCanvas(this.scratch2, width, height);
  }

  async render(plan: FramePlan, sources: FrameSources): Promise<void> {
    await sources.prepare(plan);
    this.drawPlan(plan, sources);
  }

  drawPlan(plan: FramePlan, sources: Pick<FrameSources, "get" | "mask">): void {
    this.setSize(plan.width, plan.height);
    const { ctx } = this;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";
    ctx.filter = "none";
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, plan.width, plan.height);
    if (plan.backgroundColor) {
      ctx.fillStyle = plan.backgroundColor;
      ctx.fillRect(0, 0, plan.width, plan.height);
    }
    for (const item of plan.items) this.drawItem(item, plan, sources);
    ctx.restore();
  }

  private drawItem(item: DrawItem, plan: FramePlan, sources: Pick<FrameSources, "get" | "mask">): void {
    switch (item.kind) {
      case "blurBackground": return this.drawBlurBackground(item, plan, sources);
      case "sceneEffect": return this.applySceneEffects(item.effects, plan);
      case "text": return this.drawTextLayer(item, plan);
      case "layer": return this.drawMediaLayer(item, plan, sources);
    }
  }

  private drawBlurBackground(item: Extract<DrawItem, { kind: "blurBackground" }>, plan: FramePlan, sources: Pick<FrameSources, "get">): void {
    const image = sources.get(item.source);
    if (!image) return;
    const { width: sw, height: sh } = item.source;
    const cover = Math.max(plan.width / sw, plan.height / sh);
    const sigma = blurSigma({ intensity: item.intensity, width: plan.width, height: plan.height });
    this.ctx.save();
    this.ctx.filter = `blur(${(sigma.x + sigma.y) / 2}px)`;
    this.ctx.drawImage(image, (plan.width - sw * cover) / 2, (plan.height - sh * cover) / 2, sw * cover, sh * cover);
    this.ctx.restore();
  }

  private clearLayer(): void {
    this.layerCtx.setTransform(1, 0, 0, 1, 0, 0);
    this.layerCtx.globalAlpha = 1;
    this.layerCtx.globalCompositeOperation = "source-over";
    this.layerCtx.filter = "none";
    this.layerCtx.clearRect(0, 0, this.layer.width, this.layer.height);
  }

  private applyEffects(effects: ResolvedEffect[], geometry: EffectGeometry): void {
    for (const effect of effects) {
      if (effect.type === "blur") this.applyBlur(effect, geometry);
      else if (effect.type === "chroma-key") this.applyChroma(chromaKeyPlan(effect.params), geometry);
      else if (effect.type === "adjust") {
        const plan = adjustPlan(effect.params);
        if (plan) this.applyAdjust(plan, geometry);
      }
    }
  }

  private gpuFor(width: number, height: number): ChromaKeyGpu | null {
    if (this.options.chromaBackend === "cpu") return null;
    if (this.chromaGpu === undefined) this.chromaGpu = ChromaKeyGpu.tryCreate(width, height);
    this.chromaGpu?.resize(width, height);
    return this.chromaGpu;
  }

  /** Keys the layer in place: transparent where it matches the key colour, despilled elsewhere. */
  private applyChroma(plan: ChromaKeyPlan, geometry: EffectGeometry): void {
    if (chromaKeyIsNoop(plan)) return;
    const gpu = this.gpuFor(this.layer.width, this.layer.height);
    if (gpu) {
      gpu.run(this.layer as CanvasImageSource, plan);
      this.layerCtx.setTransform(1, 0, 0, 1, 0, 0);
      this.layerCtx.globalAlpha = 1;
      this.layerCtx.filter = "none";
      this.layerCtx.globalCompositeOperation = "copy";
      this.layerCtx.drawImage(gpu.canvas as CanvasImageSource, 0, 0);
      this.layerCtx.globalCompositeOperation = "source-over";
      this.lastChromaBackend = "gpu";
      return;
    }
    const reach = Math.hypot(geometry.width, geometry.height) / 2 + 2;
    const x = Math.max(0, Math.floor(geometry.centerX - reach));
    const y = Math.max(0, Math.floor(geometry.centerY - reach));
    const w = Math.min(this.layer.width, Math.ceil(geometry.centerX + reach)) - x;
    const h = Math.min(this.layer.height, Math.ceil(geometry.centerY + reach)) - y;
    if (w <= 0 || h <= 0) return;
    const image = this.layerCtx.getImageData(x, y, w, h);
    applyChromaKey(image.data, plan);
    this.layerCtx.putImageData(image, x, y);
    this.lastChromaBackend = "cpu";
  }

  private applyBlur(effect: ResolvedEffect, size: { width: number; height: number }): void {
    const sigma = blurSigma({ intensity: numberParam(effect.params, "intensity", 15), ...size });
    const radius = (sigma.x + sigma.y) / 2;
    if (radius < 0.05) return;
    this.copyLayerTo(this.scratchCtx);
    this.layerCtx.globalCompositeOperation = "copy";
    this.layerCtx.filter = `blur(${radius}px)`;
    this.layerCtx.drawImage(this.scratch as CanvasImageSource, 0, 0);
    this.layerCtx.filter = "none";
    this.layerCtx.globalCompositeOperation = "source-over";
  }

  private copyLayerTo(target: AnyContext, filter = "none"): void {
    target.setTransform(1, 0, 0, 1, 0, 0);
    target.globalAlpha = 1;
    target.globalCompositeOperation = "copy";
    target.filter = filter;
    target.drawImage(this.layer as CanvasImageSource, 0, 0);
    target.filter = "none";
    target.globalCompositeOperation = "source-over";
  }

  /** Colour work stays on the GPU path: CSS filter chain, translucent fills clipped to the layer's own pixels, and an overlay high-pass. */
  private applyAdjust(plan: AdjustPlan, geometry: EffectGeometry): void {
    const lc = this.layerCtx;
    const { width: w, height: h } = this.layer;
    if (plan.filter !== "none") {
      this.copyLayerTo(this.scratchCtx);
      lc.globalCompositeOperation = "copy";
      lc.filter = plan.filter;
      lc.drawImage(this.scratch as CanvasImageSource, 0, 0);
      lc.filter = "none";
    }
    lc.globalCompositeOperation = "source-atop";
    for (const cast of plan.casts) {
      lc.fillStyle = `rgba(${cast.r},${cast.g},${cast.b},${cast.alpha})`;
      lc.fillRect(0, 0, w, h);
    }
    if (plan.vignette > 0) {
      const radius = Math.hypot(geometry.width, geometry.height) / 2;
      const gradient = lc.createRadialGradient(geometry.centerX, geometry.centerY, radius * 0.45, geometry.centerX, geometry.centerY, radius);
      gradient.addColorStop(0, "rgba(0,0,0,0)");
      gradient.addColorStop(1, `rgba(0,0,0,${plan.vignette})`);
      lc.fillStyle = gradient;
      lc.fillRect(0, 0, w, h);
    }
    lc.globalCompositeOperation = "source-over";
    if (plan.sharpen > 0) this.sharpen(plan.sharpen, geometry.height);
  }

  /** High-pass sharpen: overlay (0.5 + 0.5 * (L - blur(L))) onto L, masked by L's own alpha. */
  private sharpen(strength: number, referenceHeight: number): void {
    const radius = Math.max(1.5, referenceHeight / 360);
    this.copyLayerTo(this.scratch2Ctx, `invert(1) blur(${radius}px)`);
    this.copyLayerTo(this.scratchCtx);
    this.scratchCtx.globalAlpha = 0.5;
    this.scratchCtx.drawImage(this.scratch2 as CanvasImageSource, 0, 0);
    this.scratchCtx.globalAlpha = 1;
    this.scratchCtx.globalCompositeOperation = "destination-in";
    this.scratchCtx.drawImage(this.layer as CanvasImageSource, 0, 0);
    this.scratchCtx.globalCompositeOperation = "source-over";
    this.layerCtx.globalAlpha = strength;
    this.layerCtx.globalCompositeOperation = "overlay";
    this.layerCtx.drawImage(this.scratch as CanvasImageSource, 0, 0);
    this.layerCtx.globalCompositeOperation = "source-over";
    this.layerCtx.globalAlpha = 1;
  }

  private composite(blend: BlendMode): void {
    this.ctx.save();
    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.ctx.globalAlpha = 1;
    this.ctx.globalCompositeOperation = compositeOperation(blend);
    this.ctx.drawImage(this.layer as CanvasImageSource, 0, 0);
    this.ctx.restore();
  }

  private applySceneEffects(effects: ResolvedEffect[], plan: FramePlan): void {
    this.clearLayer();
    this.layerCtx.drawImage(this.canvas as CanvasImageSource, 0, 0);
    this.applyEffects(effects, { width: plan.width, height: plan.height, centerX: plan.width / 2, centerY: plan.height / 2 });
    this.ctx.save();
    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.ctx.globalCompositeOperation = "copy";
    this.ctx.drawImage(this.layer as CanvasImageSource, 0, 0);
    this.ctx.restore();
  }

  private drawTextLayer(item: TextLayer, plan: FramePlan): void {
    this.clearLayer();
    this.layerCtx.globalAlpha = item.opacity;
    drawText({ ctx: this.layerCtx, params: item.params, canvasWidth: plan.width, canvasHeight: plan.height, seconds: item.seconds });
    this.layerCtx.globalAlpha = 1;
    this.applyEffects(item.effects, { width: plan.width, height: plan.height, centerX: plan.width / 2, centerY: plan.height / 2 });
    this.composite(item.blendMode);
  }

  /** Cuts the person out of the freshly painted layer: the mask is painted through the layer's own transform and keeps only what it covers. */
  private applyBackgroundRemoval(item: MediaLayer, sources: Pick<FrameSources, "get" | "mask">, paintMatte: (matte: AnyCanvas) => void): void {
    const effect = item.effects.find((e) => e.type === "remove-background");
    if (!effect || item.source.type === "graphic") return;
    const frame = sources.mask?.(item.source);
    if (!frame) return;
    const matte = this.masks.rasterize(frame, { softness: numberParam(effect.params, "softness", 40), invert: effect.params.invert === true });
    paintMatte(matte);
    this.layerCtx.globalCompositeOperation = "destination-in";
    this.layerCtx.globalAlpha = 1;
    this.layerCtx.setTransform(1, 0, 0, 1, 0, 0);
    this.layerCtx.drawImage(this.scratch2 as CanvasImageSource, 0, 0);
    this.layerCtx.globalCompositeOperation = "source-over";
  }

  private drawMediaLayer(item: MediaLayer, plan: FramePlan, sources: Pick<FrameSources, "get" | "mask">): void {
    const t = item.transform;
    const image = item.source.type === "graphic"
      ? (isSizedGraphic(item.source.definitionId)
        ? this.graphics.getSized(item.source.definitionId, item.source.params, { width: t.width, height: t.height, canvasHeight: plan.height })
        : this.graphics.get(item.source.definitionId, item.source.params)) as CanvasImageSource
      : sources.get(item.source);
    if (!image) return;
    const look = item.transition ? transitionLook(item.transition) : null;
    const centerX = t.centerX + (look ? look.shiftX * plan.width : 0);
    const scale = look?.scale ?? 1;
    const drawnWidth = t.width * scale;
    const drawnHeight = t.height * scale;
    this.clearLayer();
    const lc = this.layerCtx;
    const paint = (ctx: AnyContext, picture: CanvasImageSource, alpha: number): void => {
      ctx.save();
      ctx.globalAlpha = alpha;
      if (look?.revealX) {
        ctx.beginPath();
        ctx.rect(look.revealX.from * plan.width, 0, (look.revealX.to - look.revealX.from) * plan.width, plan.height);
        ctx.clip();
      }
      ctx.translate(centerX, t.centerY);
      ctx.rotate((t.rotationDegrees * Math.PI) / 180);
      ctx.scale(t.flipX ? -1 : 1, t.flipY ? -1 : 1);
      if (item.crop) {
        const { width: iw, height: ih } = imageSize(picture);
        const c = item.crop;
        ctx.drawImage(
          picture, c.left * iw, c.top * ih, (1 - c.left - c.right) * iw, (1 - c.top - c.bottom) * ih,
          -drawnWidth / 2 + c.left * drawnWidth, -drawnHeight / 2 + c.top * drawnHeight,
          (1 - c.left - c.right) * drawnWidth, (1 - c.top - c.bottom) * drawnHeight,
        );
      } else {
        ctx.drawImage(picture, -drawnWidth / 2, -drawnHeight / 2, drawnWidth, drawnHeight);
      }
      ctx.restore();
    };
    paint(lc, image, item.opacity * (look?.alpha ?? 1));
    this.applyBackgroundRemoval(item, sources, (matte) => {
      this.scratch2Ctx.setTransform(1, 0, 0, 1, 0, 0);
      this.scratch2Ctx.globalCompositeOperation = "source-over";
      this.scratch2Ctx.globalAlpha = 1;
      this.scratch2Ctx.filter = "none";
      this.scratch2Ctx.clearRect(0, 0, this.scratch2.width, this.scratch2.height);
      paint(this.scratch2Ctx, matte as CanvasImageSource, 1);
    });

    this.applyEffects(item.effects, { width: drawnWidth, height: drawnHeight, centerX, centerY: t.centerY });
    if (look && look.darkness > 0) {
      lc.globalCompositeOperation = "source-atop";
      lc.fillStyle = `rgba(0,0,0,${look.darkness})`;
      lc.fillRect(0, 0, plan.width, plan.height);
      lc.globalCompositeOperation = "source-over";
    }

    let stroke: AnyCanvas | null = null;
    if (item.mask) {
      const input = {
        type: item.mask.mask.type, params: item.mask.params, center: { x: centerX, y: t.centerY }, width: drawnWidth, height: drawnHeight,
        rotationDegrees: t.rotationDegrees, flipX: t.flipX, flipY: t.flipY, canvasWidth: plan.width, canvasHeight: plan.height,
      };
      const mask = renderMask(input);
      this.layerCtx.globalCompositeOperation = isInverted(item.mask.params) ? "destination-out" : "destination-in";
      this.layerCtx.drawImage(mask as CanvasImageSource, 0, 0);
      this.layerCtx.globalCompositeOperation = "source-over";
      stroke = renderMaskStroke(input);
    }
    this.composite(item.blendMode);
    if (stroke) {
      this.ctx.save();
      this.ctx.drawImage(stroke as CanvasImageSource, 0, 0);
      this.ctx.restore();
    }
  }
}
