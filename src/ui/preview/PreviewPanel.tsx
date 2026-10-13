import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { formatTimecode, parseTimecode } from "#/engine/time";
import { totalDuration } from "#/engine/timeline";
import { getServices } from "#/app/services";
import { invokeAction } from "#/app/actions";
import { useEditorState, usePlaybackState, useSettings, useTracks } from "#/app/hooks";
import { PreviewRenderer } from "#/app/preview-renderer";
import { Icon } from "../icons";
import { Button } from "../primitives/Button";
import { SelectField } from "../primitives/fields";
import { PreviewOverlay } from "./PreviewOverlay";
import { ColorPickCapture } from "./ColorPickCapture";
import { PointPickCapture } from "./PointPickCapture";
import { clampPreviewZoom, PREVIEW_ZOOM_PRESETS, PREVIEW_ZOOM_STEP, type PreviewView } from "./view";

function EditableTimecode(): ReactNode {
  const { editor } = getServices();
  const fps = useSettings().fps;
  const time = usePlaybackState((s) => s.currentTime);
  const [draft, setDraft] = useState<string | null>(null);
  const commit = (): void => {
    if (draft === null) return;
    const parsed = parseTimecode(draft, fps);
    setDraft(null);
    if (parsed !== null) editor.playback.seek(parsed, performance.now());
  };
  return draft === null ? (
    <button type="button" className="mono" aria-label="Current time, click to edit" onClick={() => setDraft(formatTimecode(time, fps))}>
      {formatTimecode(time, fps)}
    </button>
  ) : (
    <input className="input input--sm mono" style={{ width: 110 }} aria-label="Edit current time" autoFocus value={draft}
      onChange={(e) => setDraft(e.target.value)} onBlur={commit}
      onKeyDown={(e) => { if (e.key === "Enter") commit(); if (e.key === "Escape") setDraft(null); }} />
  );
}

export function PreviewPanel(): ReactNode {
  const settings = useSettings();
  const tracks = useTracks();
  const isPlaying = usePlaybackState((s) => s.isPlaying);
  const duration = totalDuration(tracks);
  const canvas = settings.canvasSize;
  const panelRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<PreviewRenderer | null>(null);
  const [renderer, setRenderer] = useState<PreviewRenderer | null>(null);
  const [vp, setVp] = useState({ width: 0, height: 0 });
  const [zoom, setZoom] = useState(1);
  const [center, setCenter] = useState({ x: canvas.width / 2, y: canvas.height / 2 });
  const hasProject = useEditorState((s) => s.meta !== null);

  useLayoutEffect(() => {
    const el = viewportRef.current;
    if (!el) return undefined;
    const update = (): void => setVp({ width: el.clientWidth, height: el.clientHeight });
    const observer = new ResizeObserver(update);
    observer.observe(el);
    update();
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return undefined;
    const r = new PreviewRenderer(el);
    rendererRef.current = r;
    setRenderer(r);
    return () => {
      r.dispose();
      rendererRef.current = null;
    };
  }, []);

  useEffect(() => { rendererRef.current?.invalidate(); }, [hasProject]);
  useEffect(() => {
    setZoom(1);
    setCenter({ x: canvas.width / 2, y: canvas.height / 2 });
  }, [canvas.width, canvas.height]);

  const fit = vp.width > 0 && vp.height > 0 ? Math.min(vp.width / canvas.width, vp.height / canvas.height) : 1;
  const scale = fit * zoom;
  const view: PreviewView = { width: vp.width, height: vp.height, scale, center, canvas };
  const sceneLeft = vp.width / 2 - center.x * scale;
  const sceneTop = vp.height / 2 - center.y * scale;

  const clampCenter = useCallback((c: { x: number; y: number }, nextScale: number) => {
    const halfW = vp.width / 2 / nextScale;
    const halfH = vp.height / 2 / nextScale;
    const clamp = (v: number, size: number, half: number): number => (size <= half * 2 ? size / 2 : Math.min(size - half, Math.max(half, v)));
    return { x: clamp(c.x, canvas.width, halfW), y: clamp(c.y, canvas.height, halfH) };
  }, [vp.width, vp.height, canvas.width, canvas.height]);

  const setZoomTo = useCallback((next: number) => {
    const clamped = clampPreviewZoom(next);
    setZoom(clamped);
    setCenter((c) => clampCenter(c, fit * clamped));
  }, [clampCenter, fit]);

  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return undefined;
    const onWheel = (e: WheelEvent): void => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        const factor = Math.exp(-Math.max(-30, Math.min(30, e.deltaY)) / 300);
        setZoomTo(zoom * factor);
      } else if (zoom > 1) {
        e.preventDefault();
        setCenter((c) => clampCenter({ x: c.x + e.deltaX / scale, y: c.y + e.deltaY / scale }, scale));
      }
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [zoom, scale, setZoomTo, clampCenter]);

  const zoomLabel = Math.abs(zoom - 1) < 0.001 ? "Fit" : `${Math.round(scale * 100)}%`;
  const zoomValue = Math.abs(zoom - 1) < 0.001 ? "fit" : "custom";

  const toggleFullscreen = (): void => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void panelRef.current?.requestFullscreen?.();
  };

  const sceneStyle = { left: sceneLeft, top: sceneTop, width: canvas.width * scale, height: canvas.height * scale };
  const backgroundColor = settings.background.type === "color" ? settings.background.color : "transparent";

  return (
    <div ref={panelRef} className="preview panel panel-box" style={{ width: "100%" }}>
      <div className="preview__viewport" ref={viewportRef} data-testid="preview-viewport">
        <div className="preview__scene" style={{ ...sceneStyle, background: backgroundColor }}>
          <canvas ref={canvasRef} width={canvas.width} height={canvas.height} aria-label="Preview of the composition" role="img" />
        </div>
        {renderer ? <PreviewOverlay renderer={renderer} view={view} onPan={(dx, dy) => setCenter((c) => clampCenter({ x: c.x - dx / scale, y: c.y - dy / scale }, scale))} /> : null}
        {renderer ? <ColorPickCapture view={view} renderer={renderer} /> : null}
        {renderer ? <PointPickCapture view={view} renderer={renderer} /> : null}
        {!hasProject ? null : duration === 0 ? (
          <div style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center", pointerEvents: "none", color: "var(--muted-foreground)", textAlign: "center", padding: 16 }}>
            <div style={{ background: "color-mix(in srgb, var(--background) 85%, transparent)", padding: "8px 14px", borderRadius: 8 }}>
              Add media to the timeline to see it here
            </div>
          </div>
        ) : null}
      </div>
      <div className="preview__toolbar">
        <div className="preview__time">
          <EditableTimecode />
          <span>/</span>
          <span className="mono" aria-label="Total duration">{formatTimecode(duration, settings.fps)}</span>
        </div>
        <Button variant="text" size="icon" label={isPlaying ? "Pause" : "Play"} onClick={() => invokeAction("toggle-play")} disabled={duration === 0}>
          <Icon name={isPlaying ? "pause" : "play"} size={20} />
        </Button>
        <div className="preview__right">
          <div style={{ width: 88 }}>
            <SelectField label="Preview zoom" value={zoomValue} onChange={(v) => {
              if (v === "fit") { setZoom(1); setCenter({ x: canvas.width / 2, y: canvas.height / 2 }); return; }
              const percent = Number(v);
              if (Number.isFinite(percent)) setZoomTo(percent / 100 / fit);
            }}
              options={[
                { value: zoomValue === "custom" ? "custom" : "fit", label: zoomLabel },
                ...(zoomValue === "custom" ? [{ value: "fit", label: "Fit" }] : []),
                ...PREVIEW_ZOOM_PRESETS.map((p) => ({ value: String(p), label: `${p}%` })),
              ]} />
          </div>
          <Button variant="text" size="icon" label="Zoom in preview" onClick={() => setZoomTo(zoom * PREVIEW_ZOOM_STEP)}><Icon name="zoom-in" /></Button>
          <Button variant="text" size="icon" label="Full screen" onClick={toggleFullscreen}><Icon name="fullscreen" /></Button>
        </div>
      </div>
    </div>
  );
}
