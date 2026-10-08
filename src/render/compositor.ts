import { numberParam, type BlendMode } from "#/engine/model";
import type { DrawItem, FramePlan, LayerSource, MediaLayer, ResolvedEffect, TextLayer } from "#/engine/render";
import { blurSigma } from "#/engine/render";
import { context2d, createCanvas, resizeCanvas, type AnyCanvas, type AnyContext } from "./canvas";
import { GraphicCache } from "./graphics";
import { isInverted, renderMask, renderMaskStroke } from "./masks";
import { drawText } from "./text";

/** Supplies pixels for media layers; rendering is two-phase so decoding can be awaited before drawing. */
export interface FrameSources {
  prepare(plan: FramePlan): Promise<void>;
  get(source: Extract<LayerSource, { type: "video" | "image" }>): CanvasImageSource | null;
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

/** Canvas2D implementation of the frame plan. A GPU/WASM compositor can replace it behind the same call. */
export class Compositor {
  private readonly ctx: AnyContext;
  private layer: AnyCanvas;
  private layerCtx: AnyContext;
  private scratch: AnyCanvas;
  private scratchCtx: AnyContext;
  private readonly graphics = new GraphicCache();

  constructor(readonly canvas: AnyCanvas) {
    this.ctx = context2d(canvas);
    this.layer = createCanvas(canvas.width, canvas.height);
    this.layerCtx = context2d(this.layer);
    this.scratch = createCanvas(canvas.width, canvas.height);
    this.scratchCtx = context2d(this.scratch);
  }

  setSize(width: number, height: number): void {
    if (this.canvas.width === width && this.canvas.height === height) return;
    resizeCanvas(this.canvas, width, height);
    resizeCanvas(this.layer, width, height);
    resizeCanvas(this.scratch, width, height);
  }

  async render(plan: FramePlan, sources: FrameSources): Promise<void> {
    await sources.prepare(plan);
    this.drawPlan(plan, sources);
  }

  drawPlan(plan: FramePlan, sources: Pick<FrameSources, "get">): void {
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

  private drawItem(item: DrawItem, plan: FramePlan, sources: Pick<FrameSources, "get">): void {
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

  private applyBlurs(effects: ResolvedEffect[], size: { width: number; height: number }): void {
    for (const effect of effects) {
      if (effect.type !== "blur") continue;
      const sigma = blurSigma({ intensity: numberParam(effect.params, "intensity", 15), ...size });
      const radius = (sigma.x + sigma.y) / 2;
      if (radius < 0.05) continue;
      this.scratchCtx.setTransform(1, 0, 0, 1, 0, 0);
      this.scratchCtx.globalCompositeOperation = "copy";
      this.scratchCtx.filter = "none";
      this.scratchCtx.drawImage(this.layer as CanvasImageSource, 0, 0);
      this.layerCtx.globalCompositeOperation = "copy";
      this.layerCtx.filter = `blur(${radius}px)`;
      this.layerCtx.drawImage(this.scratch as CanvasImageSource, 0, 0);
      this.layerCtx.filter = "none";
      this.layerCtx.globalCompositeOperation = "source-over";
    }
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
    this.applyBlurs(effects, { width: plan.width, height: plan.height });
    this.ctx.save();
    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.ctx.globalCompositeOperation = "copy";
    this.ctx.drawImage(this.layer as CanvasImageSource, 0, 0);
    this.ctx.restore();
  }

  private drawTextLayer(item: TextLayer, plan: FramePlan): void {
    this.clearLayer();
    this.layerCtx.globalAlpha = item.opacity;
    drawText({ ctx: this.layerCtx, params: item.params, canvasWidth: plan.width, canvasHeight: plan.height });
    this.layerCtx.globalAlpha = 1;
    this.applyBlurs(item.effects, { width: plan.width, height: plan.height });
    this.composite(item.blendMode);
  }

  private drawMediaLayer(item: MediaLayer, plan: FramePlan, sources: Pick<FrameSources, "get">): void {
    const image = item.source.type === "graphic"
      ? (this.graphics.get(item.source.definitionId, item.source.params) as CanvasImageSource)
      : sources.get(item.source);
    if (!image) return;
    const t = item.transform;
    this.clearLayer();
    const lc = this.layerCtx;
    lc.save();
    lc.globalAlpha = item.opacity;
    lc.translate(t.centerX, t.centerY);
    lc.rotate((t.rotationDegrees * Math.PI) / 180);
    lc.scale(t.flipX ? -1 : 1, t.flipY ? -1 : 1);
    lc.drawImage(image, -t.width / 2, -t.height / 2, t.width, t.height);
    lc.restore();

    this.applyBlurs(item.effects, { width: t.width, height: t.height });

    let stroke: AnyCanvas | null = null;
    if (item.mask) {
      const input = {
        type: item.mask.mask.type, params: item.mask.params, center: { x: t.centerX, y: t.centerY }, width: t.width, height: t.height,
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
