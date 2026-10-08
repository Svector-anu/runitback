import { currentScene, moveElements, updateElements, retimeKeyframeCommand, batch } from "#/engine/commands";
import { listKeyframes } from "#/engine/animation";
import type { Editor } from "#/engine/editor";
import type { ElementRef, TimelineElement } from "#/engine/model";
import { EMPTY_SELECTION } from "#/engine/model";
import { mediaTime, roundToFrame, snappedSeekTime, TICKS_PER_SECOND } from "#/engine/time";
import {
  applyBoxSelection, bookmarkSnapPoints, buildMoveGroup, buildResizeMembers, computeDropTarget, computeGroupResize, elementSnapPoints,
  elementsInBox, getElement, isSelected, keyframeSnapPoints, mintTrackIds, playheadSnapPoint, resolveGroupMove,
  resolveSnap, selectOnly, snapGroupEdges, snapResizeDelta, snapThresholdTicks, toggleSelection, type ResizeSide,
} from "#/engine/timeline";
import { Store } from "#/app/store";
import { DRAG_THRESHOLD_PX, HEADER_HEIGHT, type TimelineGeometry } from "./layout";
import type { Viewport } from "./useViewport";
import { commitEdit } from "../lib/edit";
import { trackPointerGesture } from "../lib/pointer-gesture";

export interface TimelineInteraction {
  /** Active gesture kind, for cursor/overlay decisions. */
  mode: "idle" | "move" | "resize" | "scrub" | "box" | "keyframe";
  snapTime: number | null;
  dropLineIndex: number | null;
  box: { left: number; top: number; right: number; bottom: number } | null;
  scrubbingSnapped: boolean;
}

export const interactionStore = new Store<TimelineInteraction>({ mode: "idle", snapTime: null, dropLineIndex: null, box: null, scrubbingSnapped: false });

export interface ControllerContext {
  editor: Editor;
  viewport: () => Viewport;
  geometry: () => TimelineGeometry;
  scroll: () => HTMLDivElement | null;
  nowMs: () => number;
}

const idle = (): void => interactionStore.set({ mode: "idle", snapTime: null, dropLineIndex: null, box: null, scrubbingSnapped: false });

function trackAreaY(ctx: ControllerContext, clientY: number): number {
  const el = ctx.scroll();
  if (!el) return 0;
  return clientY - el.getBoundingClientRect().top + el.scrollTop - HEADER_HEIGHT;
}

/** Scrolls the timeline while the pointer is near its edges. Returns a stop function. */
function edgeAutoScroll(ctx: ControllerContext, getPointer: () => { x: number; y: number }): () => void {
  let frame = 0;
  const THRESHOLD = 100;
  const MAX_SPEED = 15;
  const tick = (): void => {
    const el = ctx.scroll();
    if (el) {
      const rect = el.getBoundingClientRect();
      const { x, y } = getPointer();
      let dx = 0;
      let dy = 0;
      if (x < rect.left + THRESHOLD) dx = -MAX_SPEED * Math.min(1, (rect.left + THRESHOLD - x) / THRESHOLD);
      else if (x > rect.right - THRESHOLD) dx = MAX_SPEED * Math.min(1, (x - (rect.right - THRESHOLD)) / THRESHOLD);
      if (y < rect.top + HEADER_HEIGHT + 20) dy = -MAX_SPEED * 0.6;
      else if (y > rect.bottom - 30) dy = MAX_SPEED * 0.6;
      if (dx !== 0) el.scrollLeft += dx;
      if (dy !== 0) el.scrollTop += dy;
    }
    frame = requestAnimationFrame(tick);
  };
  frame = requestAnimationFrame(tick);
  return () => cancelAnimationFrame(frame);
}

function onEscape(handler: () => void): () => void {
  const listener = (e: KeyboardEvent): void => {
    if (e.key === "Escape") {
      e.stopPropagation();
      e.preventDefault();
      handler();
    }
  };
  window.addEventListener("keydown", listener, true);
  return () => window.removeEventListener("keydown", listener, true);
}

// ---- Clip move -----------------------------------------------------------------------------------------------

export function startClipDrag(ctx: ControllerContext, down: PointerEvent, ref: ElementRef): void {
  const { editor } = ctx;
  const state = editor.getState();
  const modifier = down.ctrlKey || down.metaKey || down.shiftKey;
  if (modifier) {
    editor.setSelection(toggleSelection(state.selection, ref));
    return;
  }
  const committed = currentScene(state.doc).tracks;
  const anchorEl = getElement(committed, ref);
  if (!anchorEl) return;
  const wasSelected = isSelected(state.selection, ref);
  const selection = wasSelected ? state.selection.elements : [ref];
  const members = buildMoveGroup({ tracks: committed, anchor: ref, selection });
  if (!members) return;

  const start = { x: down.clientX, y: down.clientY };
  const clickOffset = ctx.viewport().clientXToTime(down.clientX) - anchorEl.startTime;
  const newTrackIds = mintTrackIds(members.length, editor.newId);
  const movingIds = new Set(members.map((m) => m.element.id));
  let dragging = false;
  let pointer = { x: down.clientX, y: down.clientY };
  let stopScroll: (() => void) | null = null;
  let offEscape: (() => void) | null = null;

  const cleanup = (): void => {
    stopTracking();
    stopScroll?.();
    offEscape?.();
    idle();
  };
  const cancel = (): void => {
    editor.discardPreview();
    cleanup();
  };

  const move = (e: PointerEvent): void => {
    pointer = { x: e.clientX, y: e.clientY };
    if (!dragging) {
      if (Math.hypot(e.clientX - start.x, e.clientY - start.y) < DRAG_THRESHOLD_PX) return;
      dragging = true;
      if (!wasSelected) editor.setSelection(selectOnly(ref));
      interactionStore.set({ mode: "move" });
      stopScroll = edgeAutoScroll(ctx, () => pointer);
      offEscape = onEscape(cancel);
    }
    const fps = editor.fps();
    const tracks = currentScene(editor.getState().doc).tracks;
    const vp = ctx.viewport();
    let anchorStart = Math.max(0, vp.clientXToTime(e.clientX) - clickOffset);
    anchorStart = roundToFrame(anchorStart, fps);

    let snapTime: number | null = null;
    if (editor.getState().snappingEnabled && !e.shiftKey) {
      const points = [
        ...elementSnapPoints({ tracks, excludeElementIds: movingIds }),
        playheadSnapPoint(editor.playback.getState().currentTime),
        ...keyframeSnapPoints({ tracks, excludeElementIds: movingIds }),
      ];
      const snapped = snapGroupEdges({
        anchorStart, points, maxDistance: snapThresholdTicks(vp.zoom),
        members: members.map((m) => ({ offset: m.timeOffset, duration: m.element.duration })),
      });
      anchorStart = Math.max(0, snapped.anchorStart);
      snapTime = snapped.snapPoint?.time ?? null;
    }

    const geometry = ctx.geometry();
    const direction = e.clientY < start.y ? "up" : e.clientY > start.y ? "down" : null;
    const target = computeDropTarget({
      tracks, elementType: anchorEl.type, mouseY: trackAreaY(ctx, e.clientY), startTime: anchorStart, duration: anchorEl.duration,
      layout: geometry.layout, verticalDirection: direction, excludeElementId: anchorEl.id,
    });
    const plan = target ? resolveGroupMove({ tracks, members, target, anchorStart, newTrackIds }) : null;
    if (plan) editor.preview(moveElements(plan));
    else editor.discardPreview();
    interactionStore.set({
      snapTime, dropLineIndex: plan && plan.createTracks.length > 0 ? (plan.createTracks[0]?.displayIndex ?? null) : null,
    });
  };

  const up = (e: PointerEvent): void => {
    if (!dragging) {
      editor.setSelection(selectOnly(ref));
      cleanup();
      return;
    }
    const close = Math.hypot(e.clientX - start.x, e.clientY - start.y) < DRAG_THRESHOLD_PX;
    if (close || !editor.isPreviewing) editor.discardPreview();
    else commitEdit(editor);
    cleanup();
  };

  const stopTracking = trackPointerGesture({ move, up, cancel });
}

// ---- Resize / trim -------------------------------------------------------------------------------------------

export function startResize(ctx: ControllerContext, down: PointerEvent, ref: ElementRef, side: ResizeSide): void {
  const { editor } = ctx;
  const state = editor.getState();
  const committed = currentScene(state.doc).tracks;
  const refs = isSelected(state.selection, ref) ? state.selection.elements : [ref];
  const members = buildResizeMembers({ tracks: committed, refs });
  if (members.length === 0) return;
  if (!isSelected(state.selection, ref)) editor.setSelection(selectOnly(ref));
  const startX = down.clientX;
  let pointer = { x: down.clientX, y: down.clientY };
  const movingIds = new Set(members.map((m) => m.element.id));
  interactionStore.set({ mode: "resize" });
  const stopScroll = edgeAutoScroll(ctx, () => pointer);

  const cleanup = (): void => {
    stopTracking();
    stopScroll();
    offEscape();
    idle();
  };
  const cancel = (): void => {
    editor.discardPreview();
    cleanup();
  };
  const offEscape = onEscape(cancel);

  const move = (e: PointerEvent): void => {
    pointer = { x: e.clientX, y: e.clientY };
    const vp = ctx.viewport();
    let delta = Math.round(((e.clientX - startX) / (50 * vp.zoom)) * TICKS_PER_SECOND);
    let snapTime: number | null = null;
    if (editor.getState().snappingEnabled && !e.shiftKey) {
      const tracks = currentScene(editor.getState().doc).tracks;
      const edges = members.map((m) => (side === "left" ? m.element.startTime : m.element.startTime + m.element.duration));
      const points = [
        ...elementSnapPoints({ tracks, excludeElementIds: movingIds }),
        playheadSnapPoint(editor.playback.getState().currentTime),
        ...keyframeSnapPoints({ tracks, excludeElementIds: movingIds }),
      ];
      const snapped = snapResizeDelta({ edges, delta, points, maxDistance: snapThresholdTicks(vp.zoom) });
      delta = snapped.delta;
      snapTime = snapped.snapPoint?.time ?? null;
    }
    const result = computeGroupResize({ members, side, delta, fps: editor.fps() });
    editor.preview(updateElements(result.patches, "Resize"));
    interactionStore.set({ snapTime });
  };
  const up = (): void => {
    if (editor.isPreviewing) commitEdit(editor);
    cleanup();
  };
  const stopTracking = trackPointerGesture({ move, up, cancel });
}

// ---- Playhead scrubbing --------------------------------------------------------------------------------------

export function startScrub(ctx: ControllerContext, down: PointerEvent, options: { fromRuler: boolean }): void {
  const { editor } = ctx;
  const playback = editor.playback;
  let moved = false;
  let pointer = { x: down.clientX, y: down.clientY };
  playback.setScrubbing(true);
  interactionStore.set({ mode: "scrub" });
  const stopScroll = edgeAutoScroll(ctx, () => pointer);

  const seekTo = (clientX: number, snap: boolean, shift: boolean): void => {
    const vp = ctx.viewport();
    const duration = editor.duration();
    let time = vp.clientXToTime(clientX);
    time = Math.min(time, Math.max(0, vp.width / (50 * vp.zoom) * TICKS_PER_SECOND));
    time = snappedSeekTime(time, duration, editor.fps());
    let snappedTo: number | null = null;
    if (snap && !shift) {
      const tracks = currentScene(editor.getState().doc).tracks;
      const points = [
        ...elementSnapPoints({ tracks }),
        ...bookmarkSnapPoints(currentScene(editor.getState().doc).bookmarks),
        ...keyframeSnapPoints({ tracks }),
      ];
      const hit = resolveSnap({ target: time, points, maxDistance: snapThresholdTicks(vp.zoom) });
      if (hit.snapPoint) {
        time = snappedSeekTime(hit.snappedTime, duration, editor.fps());
        snappedTo = hit.snappedTime;
      }
    }
    interactionStore.set({ scrubbingSnapped: snappedTo !== null, snapTime: snappedTo });
    playback.seek(time, ctx.nowMs());
  };

  seekTo(down.clientX, false, down.shiftKey);
  const move = (e: PointerEvent): void => {
    pointer = { x: e.clientX, y: e.clientY };
    moved = true;
    seekTo(e.clientX, true, e.shiftKey);
  };
  const finish = (): void => {
    stopScroll();
    playback.setScrubbing(false);
    editor.setViewState({ playheadTime: playback.getState().currentTime });
    idle();
  };
  const up = (e: PointerEvent): void => {
    if (!moved && options.fromRuler) seekTo(e.clientX, false, true);
    finish();
  };
  trackPointerGesture({ move, up, cancel: finish });
}

// ---- Track-area click and box select -------------------------------------------------------------------------

export function startBackgroundGesture(ctx: ControllerContext, down: PointerEvent): void {
  const { editor } = ctx;
  const scrollEl = ctx.scroll();
  if (!scrollEl) return;
  const additive = down.shiftKey || down.ctrlKey || down.metaKey;
  const baseSelection = editor.getState().selection;
  const startContent = {
    x: down.clientX - scrollEl.getBoundingClientRect().left + scrollEl.scrollLeft,
    y: trackAreaY(ctx, down.clientY),
  };
  const startedAt = performance.now();
  let boxing = false;
  let pointer = { x: down.clientX, y: down.clientY };
  const stopScroll = edgeAutoScroll(ctx, () => pointer);

  const toContent = (e: PointerEvent): { x: number; y: number } => {
    const el = ctx.scroll() as HTMLDivElement;
    return { x: e.clientX - el.getBoundingClientRect().left + el.scrollLeft, y: trackAreaY(ctx, e.clientY) };
  };
  const move = (e: PointerEvent): void => {
    pointer = { x: e.clientX, y: e.clientY };
    const p = toContent(e);
    if (!boxing && Math.hypot(p.x - startContent.x, p.y - startContent.y) < DRAG_THRESHOLD_PX) return;
    boxing = true;
    const box = { left: Math.min(p.x, startContent.x), right: Math.max(p.x, startContent.x), top: Math.min(p.y, startContent.y), bottom: Math.max(p.y, startContent.y) };
    interactionStore.set({ mode: "box", box });
    const vp = ctx.viewport();
    const hits = elementsInBox({ tracks: currentScene(editor.getState().doc).tracks, box, layout: ctx.geometry().layout, timeToX: vp.timeToX });
    editor.setSelection(applyBoxSelection({ current: baseSelection, hits, additive }));
  };
  const cancel = (): void => {
    stopScroll();
    if (boxing) editor.setSelection(baseSelection);
    idle();
  };
  const up = (e: PointerEvent): void => {
    stopScroll();
    if (!boxing && performance.now() - startedAt < 500) {
      editor.setSelection(EMPTY_SELECTION);
      const time = snappedSeekTime(ctx.viewport().clientXToTime(e.clientX), editor.duration(), editor.fps());
      editor.playback.seek(time, ctx.nowMs());
      editor.setViewState({ playheadTime: time });
    }
    idle();
  };
  trackPointerGesture({ move, up, cancel });
}

// ---- Keyframe dragging ---------------------------------------------------------------------------------------

export function startKeyframeDrag(ctx: ControllerContext, down: PointerEvent, ref: ElementRef, path: string, keyframeId: string): void {
  const { editor } = ctx;
  const el = getElement(currentScene(editor.getState().doc).tracks, ref);
  if (!el) return;
  const key = listKeyframes(el.animations).find((k) => k.id === keyframeId && k.path === path);
  if (!key) return;
  const keyRef = { ...ref, propertyPath: path, keyframeId };
  const current = editor.getState().selection;
  const alreadySelected = current.keyframes.some((k) => k.keyframeId === keyframeId && k.propertyPath === path);
  const modifier = down.ctrlKey || down.metaKey;
  const selected = alreadySelected ? current.keyframes
    : modifier ? [...current.keyframes, keyRef] : [keyRef];
  editor.setSelection({ elements: current.elements.length ? current.elements : [ref], keyframes: selected, keyframeAnchor: keyRef });
  editor.playback.seek(el.startTime + key.time, ctx.nowMs());

  const startX = down.clientX;
  let moved = false;
  const startTimes = selected.map((k) => {
    const target = getElement(currentScene(editor.getState().doc).tracks, { trackId: k.trackId, elementId: k.elementId });
    const kf = target ? listKeyframes(target.animations).find((x) => x.id === k.keyframeId && x.path === k.propertyPath) : undefined;
    return { ref: k, time: kf?.time ?? 0, duration: target?.duration ?? 0 };
  });
  const move = (e: PointerEvent): void => {
    if (!moved && Math.abs(e.clientX - startX) < DRAG_THRESHOLD_PX) return;
    moved = true;
    interactionStore.set({ mode: "keyframe" });
    const delta = roundToFrame(Math.round(((e.clientX - startX) / (50 * ctx.viewport().zoom)) * TICKS_PER_SECOND), editor.fps());
    editor.preview(batch("Move keyframes", startTimes.map((s) => retimeKeyframeCommand({
      ref: { trackId: s.ref.trackId, elementId: s.ref.elementId }, path: s.ref.propertyPath, keyframeId: s.ref.keyframeId,
      nextTime: mediaTime(Math.min(s.duration, Math.max(0, s.time + delta))),
    }))));
  };
  const up = (): void => {
    offEscape();
    if (moved && editor.isPreviewing) commitEdit(editor);
    idle();
  };
  const cancel = (): void => {
    editor.discardPreview();
    stopTracking();
    offEscape();
    idle();
  };
  const offEscape = onEscape(cancel);
  const stopTracking = trackPointerGesture({ move, up, cancel });
}

export type { TimelineElement };
