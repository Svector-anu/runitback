import { TICKS_PER_SECOND, mediaTime, roundMediaTime, type MediaTime } from "#/engine/time";

export const BASE_PIXELS_PER_SECOND = 50;
export const ZOOM_MAX = 100;
export const ZOOM_BUTTON_FACTOR = 1.7;
export const SNAP_THRESHOLD_PX = 10;
export const MIN_CONTENT_FRACTION_AT_MIN_ZOOM = 0.25;
export const WHEEL_ZOOM_SENSITIVITY = 300;
export const WHEEL_ZOOM_CAP = 30;

export const pixelsPerSecond = (zoom: number): number => BASE_PIXELS_PER_SECOND * zoom;

export function timeToPixels(time: number, zoom: number): number {
  return (time / TICKS_PER_SECOND) * pixelsPerSecond(zoom);
}

export function pixelsToTime(px: number, zoom: number): MediaTime {
  return roundMediaTime((px / pixelsPerSecond(zoom)) * TICKS_PER_SECOND);
}

/** Snaps a CSS pixel to the device grid so 1px lines render crisp. */
export function snapToDevicePixel(px: number, devicePixelRatio: number): number {
  return Math.round(px * devicePixelRatio) / devicePixelRatio;
}

export function snapThresholdTicks(zoom: number): number {
  return Math.round((SNAP_THRESHOLD_PX / pixelsPerSecond(zoom)) * TICKS_PER_SECOND);
}

/** Smallest zoom: content fills a quarter of the viewport. */
export function minZoomFor(input: { containerWidth: number; durationSeconds: number }): number {
  const seconds = Math.max(input.durationSeconds, 1);
  return Math.min(ZOOM_MAX, (input.containerWidth * MIN_CONTENT_FRACTION_AT_MIN_ZOOM) / (seconds * BASE_PIXELS_PER_SECOND));
}

export function clampZoom(zoom: number, minZoom: number): number {
  return Math.min(ZOOM_MAX, Math.max(minZoom, zoom));
}

/** Viewport padding after the content: 75% of the viewport at min zoom falling to 15% by 20% zoom. */
export function trailingPadding(input: { zoom: number; minZoom: number; containerWidth: number }): number {
  const range = ZOOM_MAX - input.minZoom;
  const percent = range <= 0 ? 1 : (input.zoom - input.minZoom) / range;
  const t = Math.min(percent / 0.2, 1);
  const ratio = 0.75 - (0.75 - 0.15) * t;
  return input.containerWidth * ratio;
}

export function contentWidth(input: { duration: number; zoom: number; minZoom: number; containerWidth: number }): number {
  const content = timeToPixels(input.duration, input.zoom);
  return Math.max(content + trailingPadding(input), input.containerWidth);
}

/** Slider position (0..1) <-> zoom, exponential. */
export function zoomToSlider(zoom: number, minZoom: number): number {
  if (minZoom >= ZOOM_MAX) return 0;
  return Math.log(zoom / minZoom) / Math.log(ZOOM_MAX / minZoom);
}
export function sliderToZoom(position: number, minZoom: number): number {
  if (minZoom >= ZOOM_MAX) return ZOOM_MAX;
  return minZoom * (ZOOM_MAX / minZoom) ** Math.min(1, Math.max(0, position));
}

export function wheelZoomFactor(deltaY: number, deltaMode: number): number {
  const delta = deltaMode === 1 ? deltaY * 16 : deltaY;
  const capped = Math.sign(delta) * Math.min(Math.abs(delta), WHEEL_ZOOM_CAP);
  return Math.exp(-capped / WHEEL_ZOOM_SENSITIVITY);
}

export const ZOOM_ANCHOR_SLIDER_THRESHOLD = 0.15;

/** New scrollLeft that keeps the playhead at the same viewport offset across a zoom change. */
export function scrollAnchoredToPlayhead(input: {
  playheadTime: number; scrollLeft: number; oldZoom: number; newZoom: number; sliderPosition: number;
}): number | null {
  if (input.sliderPosition < ZOOM_ANCHOR_SLIDER_THRESHOLD) return null;
  const before = timeToPixels(input.playheadTime, input.oldZoom);
  const after = timeToPixels(input.playheadTime, input.newZoom);
  return Math.max(0, after - (before - input.scrollLeft));
}

export function mouseTime(input: { clientX: number; containerLeft: number; scrollLeft: number; zoom: number }): MediaTime {
  return mediaTime(Math.max(0, pixelsToTime(input.clientX - input.containerLeft + input.scrollLeft, input.zoom)));
}
