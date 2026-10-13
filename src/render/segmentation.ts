import { maskAlphaTable, type MaskFrame } from "#/engine/segmentation";
import { context2d, createCanvas, resizeCanvas, type AnyCanvas, type AnyContext } from "./canvas";

/** Turns a person-confidence mask into a canvas whose alpha is the matte (white where the clip stays visible). */
export class MaskRasterizer {
  private canvas: AnyCanvas | null = null;
  private ctx: AnyContext | null = null;
  private tableKey = "";
  private table: Uint8Array = new Uint8Array(256);

  rasterize(frame: MaskFrame, params: { softness: number; invert: boolean }): AnyCanvas {
    const key = `${params.softness}:${params.invert}`;
    if (key !== this.tableKey) {
      this.table = maskAlphaTable(params);
      this.tableKey = key;
    }
    if (!this.canvas || !this.ctx) {
      this.canvas = createCanvas(frame.width, frame.height);
      this.ctx = context2d(this.canvas);
    }
    resizeCanvas(this.canvas, frame.width, frame.height);
    const image = this.ctx.createImageData(frame.width, frame.height);
    const out = image.data;
    for (let i = 0, j = 0; i < frame.data.length; i++, j += 4) {
      out[j] = 255; out[j + 1] = 255; out[j + 2] = 255;
      out[j + 3] = this.table[frame.data[i] as number] as number;
    }
    this.ctx.putImageData(image, 0, 0);
    return this.canvas;
  }
}
