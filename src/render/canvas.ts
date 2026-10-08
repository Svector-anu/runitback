export type AnyCanvas = HTMLCanvasElement | OffscreenCanvas;
export type AnyContext = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

export function createCanvas(width: number, height: number): AnyCanvas {
  if (typeof OffscreenCanvas !== "undefined") return new OffscreenCanvas(width, height);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

export function context2d(canvas: AnyCanvas): AnyContext {
  const ctx = canvas.getContext("2d", { willReadFrequently: false }) as AnyContext | null;
  if (!ctx) throw new Error("Canvas 2D is not available");
  return ctx;
}

export function resizeCanvas(canvas: AnyCanvas, width: number, height: number): void {
  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== height) canvas.height = height;
}
