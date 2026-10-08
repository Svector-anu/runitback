import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { batch, currentScene } from "#/engine/commands";
import { numberParam, PARAM, type ElementRef, type TimelineElement } from "#/engine/model";
import type { FramePlan } from "#/engine/render";
import { getElement, isSelected, toggleSelection } from "#/engine/timeline";
import { getServices } from "#/app/services";
import { useEditorState } from "#/app/hooks";
import { paramEditCommand } from "#/app/param-edit";
import { hitTest, planBounds, type ElementBounds } from "#/render/bounds";
import { PREVIEW_SNAP_SCREEN_PX, normalizeDelta, snapPosition, snapRotation } from "#/render/snap";
import { Icon } from "../icons";
import { TextEditOverlay } from "./TextEditOverlay";
import { canvasToScreen, screenToCanvas, type PreviewView } from "./view";
import { commitEdit } from "../lib/edit";
import { trackPointerGesture } from "../lib/pointer-gesture";

type HandleId = "nw" | "ne" | "se" | "sw" | "right" | "left" | "bottom" | "rotate";

const CURSORS: Record<HandleId, string> = { nw: "nwse-resize", se: "nwse-resize", ne: "nesw-resize", sw: "nesw-resize", right: "ew-resize", left: "ew-resize", bottom: "ns-resize", rotate: "grab" };
const ROTATE_OFFSET = 24;
const MIN_DRAG = 0.5;

function rotate(x: number, y: number, degrees: number): { x: number; y: number } {
  const r = (degrees * Math.PI) / 180;
  return { x: x * Math.cos(r) - y * Math.sin(r), y: x * Math.sin(r) + y * Math.cos(r) };
}

function handlePoints(b: ElementBounds): Array<{ id: HandleId; x: number; y: number }> {
  const hw = b.width / 2;
  const hh = b.height / 2;
  const at = (lx: number, ly: number): { x: number; y: number } => {
    const p = rotate(lx, ly, b.rotationDegrees);
    return { x: b.cx + p.x, y: b.cy + p.y };
  };
  return [
    { id: "nw", ...at(-hw, -hh) }, { id: "ne", ...at(hw, -hh) }, { id: "se", ...at(hw, hh) }, { id: "sw", ...at(-hw, hh) },
    { id: "right", ...at(hw, 0) }, { id: "left", ...at(-hw, 0) }, { id: "bottom", ...at(0, hh) },
  ];
}

export function PreviewOverlay({ renderer, view, onPan }: {
  renderer: { onPlan: ((plan: FramePlan) => void) | null; lastPlan: FramePlan | null }; view: PreviewView; onPan: (dx: number, dy: number) => void;
}): ReactNode {
  const { editor } = getServices();
  const selection = useEditorState((s) => s.selection);
  const [plan, setPlan] = useState<FramePlan | null>(renderer.lastPlan);
  const [guides, setGuides] = useState<{ x: number | null; y: number | null }>({ x: null, y: null });
  const [editing, setEditing] = useState<ElementRef | null>(null);
  const viewRef = useRef(view);
  viewRef.current = view;

  useEffect(() => {
    renderer.onPlan = setPlan;
    setPlan(renderer.lastPlan);
    return () => { renderer.onPlan = null; };
  }, [renderer]);

  const bounds = useMemo(() => (plan ? planBounds(plan) : []), [plan]);
  const selectedIds = useMemo(() => new Set(selection.elements.map((r) => r.elementId)), [selection.elements]);
  const selectedBounds = bounds.filter((b) => selectedIds.has(b.elementId));
  const single = selectedBounds.length === 1 && selection.elements.length === 1 ? selectedBounds[0] : undefined;

  const refFor = (elementId: string): ElementRef | null => {
    const tracks = currentScene(editor.getState().doc).tracks;
    for (const track of [...tracks.overlay, tracks.main]) {
      if (track.elements.some((e) => e.id === elementId)) return { trackId: track.id, elementId };
    }
    return null;
  };

  const canvasPoint = (e: { clientX: number; clientY: number }, host: HTMLElement): { x: number; y: number } => {
    const rect = host.getBoundingClientRect();
    return screenToCanvas(viewRef.current, e.clientX - rect.left, e.clientY - rect.top);
  };

  const editCommand = (ref: ElementRef, element: TimelineElement, values: Record<string, number>): ReturnType<typeof paramEditCommand> =>
    paramEditCommand({ element, ref, values, playhead: editor.playback.getState().currentTime, label: "Transform" });

  const trackWindow = (finish: (committed: boolean) => void, move: (e: PointerEvent) => void): void => {
    const release = (): void => {
      window.removeEventListener("keydown", onKey, true);
      setGuides({ x: null, y: null });
    };
    const stopTracking = trackPointerGesture({
      move,
      up: () => { release(); finish(true); },
      cancel: () => { release(); finish(false); },
    });
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") { e.stopPropagation(); stopTracking(); release(); finish(false); }
    };
    window.addEventListener("keydown", onKey, true);
  };

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (e.button === 1) {
      e.preventDefault();
      let last = { x: e.clientX, y: e.clientY };
      trackWindow(() => undefined, (ev) => { onPan(ev.clientX - last.x, ev.clientY - last.y); last = { x: ev.clientX, y: ev.clientY }; });
      return;
    }
    if (e.button !== 0) return;
    const host = e.currentTarget;
    const start = canvasPoint(e, host);
    const hit = hitTest(bounds, start.x, start.y);
    const modifier = e.ctrlKey || e.metaKey || e.shiftKey;
    const hitRef = hit ? refFor(hit.elementId) : null;

    if (!hit || !hitRef) {
      if (!modifier) editor.clearSelection();
      return;
    }
    if (modifier) {
      editor.setSelection(toggleSelection(editor.getState().selection, hitRef));
      return;
    }
    const state = editor.getState();
    const alreadySelected = isSelected(state.selection, hitRef);
    const targets = alreadySelected ? state.selection.elements : [hitRef];
    if (!alreadySelected) editor.setSelection({ elements: [hitRef], keyframes: [], keyframeAnchor: null });

    const tracks = currentScene(state.doc).tracks;
    const items = targets.flatMap((ref) => {
      const el = getElement(tracks, ref);
      const b = bounds.find((x) => x.elementId === ref.elementId);
      return el && b && el.type !== "audio" && el.type !== "effect"
        ? [{ ref, el, b, x0: numberParam(el.params, PARAM.positionX, 0), y0: numberParam(el.params, PARAM.positionY, 0) }] : [];
    });
    const first = items.find((i) => i.ref.elementId === hitRef.elementId) ?? items[0];
    if (!first) return;
    const startScreen = { x: e.clientX, y: e.clientY };
    let moved = false;

    trackWindow((committed) => {
      if (!moved) {
        if (alreadySelected && state.selection.elements.length > 1 && committed) editor.setSelection({ elements: [hitRef], keyframes: [], keyframeAnchor: null });
        editor.discardPreview();
        return;
      }
      if (committed && editor.isPreviewing) commitEdit(editor);
      else editor.discardPreview();
    }, (ev) => {
      const v = viewRef.current;
      if (!moved && Math.hypot(ev.clientX - startScreen.x, ev.clientY - startScreen.y) / v.scale < MIN_DRAG) return;
      moved = true;
      let dx = (ev.clientX - startScreen.x) / v.scale;
      let dy = (ev.clientY - startScreen.y) / v.scale;
      let guide: { x: number | null; y: number | null } = { x: null, y: null };
      if (!ev.shiftKey && editor.getState().snappingEnabled) {
        const snap = snapPosition({
          cx: first.b.cx - v.canvas.width / 2 + dx, cy: first.b.cy - v.canvas.height / 2 + dy, width: first.b.width, height: first.b.height,
          rotationDegrees: first.b.rotationDegrees, canvasWidth: v.canvas.width, canvasHeight: v.canvas.height, threshold: PREVIEW_SNAP_SCREEN_PX / v.scale,
        });
        dx += snap.dx;
        dy += snap.dy;
        guide = { x: snap.guideX, y: snap.guideY };
      }
      setGuides(guide);
      editor.preview(batch("Move", items.map((i) => editCommand(i.ref, i.el, { [PARAM.positionX]: Math.round(i.x0 + dx), [PARAM.positionY]: Math.round(i.y0 + dy) }))));
    });
  };

  const onHandleDown = (e: React.PointerEvent, id: HandleId, b: ElementBounds): void => {
    e.preventDefault();
    e.stopPropagation();
    const ref = refFor(b.elementId);
    const host = (e.currentTarget as HTMLElement).closest(".preview__overlay") as HTMLElement | null;
    if (!ref || !host) return;
    const el = getElement(currentScene(editor.getState().doc).tracks, ref);
    if (!el) return;
    const sx0 = numberParam(el.params, PARAM.scaleX, 1);
    const sy0 = numberParam(el.params, PARAM.scaleY, 1);
    const rot0 = numberParam(el.params, PARAM.rotate, 0);
    const startPoint = canvasPoint(e, host);
    const d0 = Math.max(1e-6, Math.hypot(startPoint.x - b.cx, startPoint.y - b.cy));
    const angle0 = (Math.atan2(startPoint.y - b.cy, startPoint.x - b.cx) * 180) / Math.PI;
    const baseW = b.width / Math.abs(sx0 || 1);
    const baseH = b.height / Math.abs(sy0 || 1);
    const sign = (n: number): number => (n < 0 ? -1 : 1);

    trackWindow((committed) => {
      if (committed && editor.isPreviewing) commitEdit(editor);
      else editor.discardPreview();
    }, (ev) => {
      const p = canvasPoint(ev, host);
      const values: Record<string, number> = {};
      if (id === "rotate") {
        const angle = (Math.atan2(p.y - b.cy, p.x - b.cx) * 180) / Math.PI;
        let next = rot0 + normalizeDelta(angle - angle0);
        if (!ev.shiftKey) next = snapRotation(next);
        values[PARAM.rotate] = Math.round(next * 100) / 100;
      } else if (id === "nw" || id === "ne" || id === "se" || id === "sw") {
        const factor = Math.hypot(p.x - b.cx, p.y - b.cy) / d0;
        values[PARAM.scaleX] = sign(sx0) * Math.max(0.01, Math.abs(sx0 * factor));
        values[PARAM.scaleY] = sign(sy0) * Math.max(0.01, Math.abs(sy0 * factor));
      } else {
        const local = rotate(p.x - b.cx, p.y - b.cy, -b.rotationDegrees);
        if (id === "left" || id === "right") values[PARAM.scaleX] = sign(sx0) * Math.max(0.01, (Math.abs(local.x) * 2) / baseW);
        else values[PARAM.scaleY] = sign(sy0) * Math.max(0.01, (Math.abs(local.y) * 2) / baseH);
      }
      for (const k of Object.keys(values)) values[k] = Math.round((values[k] as number) * 1000) / 1000;
      editor.preview(editCommand(ref, el, values));
    });
  };

  const onDoubleClick = (e: React.MouseEvent<HTMLDivElement>): void => {
    const p = canvasPoint(e, e.currentTarget);
    const hit = hitTest(bounds, p.x, p.y);
    const ref = hit ? refFor(hit.elementId) : null;
    if (!hit || !ref) return;
    const el = getElement(currentScene(editor.getState().doc).tracks, ref);
    if (el?.type === "text") {
      editor.setSelection({ elements: [ref], keyframes: [], keyframeAnchor: null });
      setEditing(ref);
    }
  };

  const outline = (b: ElementBounds, key: string, dashed = false): ReactNode => {
    const c = canvasToScreen(view, b.cx, b.cy);
    return (
      <div key={key} style={{
        position: "absolute", left: c.x, top: c.y, width: b.width * view.scale, height: b.height * view.scale,
        transform: `translate(-50%, -50%) rotate(${b.rotationDegrees}deg)`, outline: `1px ${dashed ? "dashed" : "solid"} rgba(255,255,255,0.75)`,
        boxShadow: "0 0 0 1px rgba(0,0,0,0.35)", pointerEvents: "none",
      }} />
    );
  };

  const editingBounds = editing ? bounds.find((b) => b.elementId === editing.elementId) : undefined;

  return (
    <div className="preview__overlay" role="application" aria-label="Preview canvas, select and transform elements"
      onPointerDown={onPointerDown} onDoubleClick={onDoubleClick} style={{ cursor: "default" }}>
      {selectedBounds.map((b) => outline(b, b.elementId))}
      {single && !editing ? (
        <>
          {handlePoints(single).map((h) => {
            const s = canvasToScreen(view, h.x, h.y);
            return (
              <div key={h.id} className={`handle ${h.id.length > 2 ? "" : ""}`} role="button" aria-label={`Resize handle ${h.id}`} style={{ left: s.x, top: s.y, cursor: CURSORS[h.id] }}
                onPointerDown={(e) => onHandleDown(e, h.id, single)} />
            );
          })}
          {(() => {
            const top = rotate(0, -single.height / 2, single.rotationDegrees);
            const up = rotate(0, -ROTATE_OFFSET / view.scale, single.rotationDegrees);
            const s = canvasToScreen(view, single.cx + top.x + up.x, single.cy + top.y + up.y);
            return (
              <div className="handle handle--rotate" role="button" aria-label="Rotation handle" style={{ left: s.x, top: s.y, cursor: CURSORS.rotate }} onPointerDown={(e) => onHandleDown(e, "rotate", single)}>
                <Icon name="rotate" />
              </div>
            );
          })()}
        </>
      ) : null}
      {guides.x !== null ? <div className="snap-guide" style={{ left: canvasToScreen(view, view.canvas.width / 2 + guides.x, 0).x, top: 0, bottom: 0, width: 1 }} /> : null}
      {guides.y !== null ? <div className="snap-guide" style={{ top: canvasToScreen(view, 0, view.canvas.height / 2 + guides.y).y, left: 0, right: 0, height: 1 }} /> : null}
      {editing && editingBounds ? <TextEditOverlay refValue={editing} bounds={editingBounds} view={view} onDone={() => setEditing(null)} /> : null}
    </div>
  );
}
