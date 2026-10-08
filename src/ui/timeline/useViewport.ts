import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { TICKS_PER_SECOND } from "#/engine/time";
import {
  ZOOM_BUTTON_FACTOR, clampZoom, contentWidth, minZoomFor, scrollAnchoredToPlayhead, sliderToZoom, timeToPixels, zoomToSlider,
} from "#/engine/timeline";
import { getServices } from "#/app/services";
import { useEditorState } from "#/app/hooks";

export interface Viewport {
  zoom: number;
  minZoom: number;
  containerWidth: number;
  scrollLeft: number;
  width: number;
  scrollRef: React.RefObject<HTMLDivElement | null>;
  setZoom(next: number, options?: { anchorClientX?: number }): void;
  zoomBy(factor: number, options?: { anchorClientX?: number }): void;
  setSlider(position: number): void;
  slider: number;
  timeToX(time: number): number;
  clientXToTime(clientX: number): number;
  scrollTo(left: number): void;
}

const DEFAULT_WIDTH = 1000;

/** Zoom, scroll and width of the timeline. Zoom keeps timeline time intact; only the scale changes. */
export function useViewport(durationTicks: number): Viewport {
  const { editor } = getServices();
  const scrollRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState(DEFAULT_WIDTH);
  const [scrollLeft, setScrollLeft] = useState(0);
  const savedZoom = useEditorState((s) => s.viewState.zoomLevel);
  const savedScroll = useEditorState((s) => s.meta?.id);
  const [zoom, setZoomState] = useState(savedZoom);
  const restoredFor = useRef<string | null>(null);

  const minZoom = minZoomFor({ containerWidth, durationSeconds: durationTicks / TICKS_PER_SECOND });
  const effectiveZoom = clampZoom(zoom, minZoom);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return undefined;
    const observer = new ResizeObserver(() => setContainerWidth(el.clientWidth || DEFAULT_WIDTH));
    observer.observe(el);
    setContainerWidth(el.clientWidth || DEFAULT_WIDTH);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return undefined;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const onScroll = (): void => {
      setScrollLeft(el.scrollLeft);
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => editor.setViewState({ scrollLeft: el.scrollLeft }), 300);
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      el.removeEventListener("scroll", onScroll);
      if (timer) clearTimeout(timer);
    };
  }, [editor]);

  useEffect(() => {
    if (!savedScroll || restoredFor.current === savedScroll) return;
    restoredFor.current = savedScroll;
    const state = editor.getState().viewState;
    setZoomState(state.zoomLevel);
    requestAnimationFrame(() => {
      if (scrollRef.current) scrollRef.current.scrollLeft = state.scrollLeft;
    });
  }, [savedScroll, editor]);

  const width = contentWidth({ duration: durationTicks, zoom: effectiveZoom, minZoom, containerWidth });

  const setZoom = useCallback((next: number, options?: { anchorClientX?: number }) => {
    const el = scrollRef.current;
    const clamped = clampZoom(next, minZoom);
    if (el) {
      const playhead = editor.playback.getState().currentTime;
      const anchored = scrollAnchoredToPlayhead({
        playheadTime: playhead, scrollLeft: el.scrollLeft, oldZoom: effectiveZoom, newZoom: clamped, sliderPosition: zoomToSlider(clamped, minZoom),
      });
      let target = anchored;
      if (target === null && options?.anchorClientX !== undefined) {
        const rect = el.getBoundingClientRect();
        const cursorX = options.anchorClientX - rect.left;
        const timeAtCursor = ((el.scrollLeft + cursorX) / effectiveZoom) / 50 * TICKS_PER_SECOND;
        target = Math.max(0, timeToPixels(timeAtCursor, clamped) - cursorX);
      }
      setZoomState(clamped);
      if (target !== null) requestAnimationFrame(() => { if (scrollRef.current) scrollRef.current.scrollLeft = target as number; });
    } else {
      setZoomState(clamped);
    }
    editor.setViewState({ zoomLevel: clamped });
  }, [editor, effectiveZoom, minZoom]);

  return {
    zoom: effectiveZoom, minZoom, containerWidth, scrollLeft, width, scrollRef, setZoom,
    zoomBy: (factor, options) => setZoom(effectiveZoom * factor, options),
    setSlider: (position) => setZoom(sliderToZoom(position, minZoom)),
    slider: zoomToSlider(effectiveZoom, minZoom),
    timeToX: (time) => timeToPixels(time, effectiveZoom),
    clientXToTime: (clientX) => {
      const el = scrollRef.current;
      const left = el?.getBoundingClientRect().left ?? 0;
      return Math.max(0, Math.round(((clientX - left + (el?.scrollLeft ?? 0)) / (50 * effectiveZoom)) * TICKS_PER_SECOND));
    },
    scrollTo: (left) => { if (scrollRef.current) scrollRef.current.scrollLeft = left; },
  };
}

export { ZOOM_BUTTON_FACTOR };
