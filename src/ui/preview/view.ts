import type { CanvasSize } from "#/engine/model";

export const PREVIEW_ZOOM_MIN = 0.25;
export const PREVIEW_ZOOM_MAX = 16;
export const PREVIEW_ZOOM_STEP = 1.25;
export const PREVIEW_ZOOM_PRESETS = [25, 50, 75, 100, 150, 200] as const;

export const clampPreviewZoom = (zoom: number): number => Math.min(PREVIEW_ZOOM_MAX, Math.max(PREVIEW_ZOOM_MIN, zoom));

export interface PreviewView {
  /** Viewport size in CSS pixels. */
  width: number;
  height: number;
  /** CSS pixels per canvas pixel. */
  scale: number;
  /** Canvas point shown at the viewport centre. */
  center: { x: number; y: number };
  canvas: CanvasSize;
}

export function screenToCanvas(view: PreviewView, x: number, y: number): { x: number; y: number } {
  return { x: view.center.x + (x - view.width / 2) / view.scale, y: view.center.y + (y - view.height / 2) / view.scale };
}

export function canvasToScreen(view: PreviewView, x: number, y: number): { x: number; y: number } {
  return { x: view.width / 2 + (x - view.center.x) * view.scale, y: view.height / 2 + (y - view.center.y) * view.scale };
}
