import type { ReactNode } from "react";
import { autoZoomCommand, currentScene } from "#/engine/commands";
import { allElements } from "#/engine/timeline";
import { zoomAtPlayhead, zoomPickStore } from "#/app/zoom-pick";
import { getServices } from "#/app/services";
import { runEdit } from "../lib/edit";
import { toast } from "../primitives/toast";
import { PickLayer } from "./PickLayer";
import type { PreviewView } from "./view";

/** Click a spot on the preview: the waiting video or image clip eases in on it at the playhead and back (the auto zoom command, one undo step). */
export function ZoomPickCapture({ view }: { view: PreviewView }): ReactNode {
  const target = zoomPickStore.use((s) => s.targetElementId);
  if (!target) return null;
  const cancel = (): void => zoomPickStore.set({ targetElementId: null });
  return (
    <PickLayer view={view} label="Click the point to zoom into" testId="zoom-pick-capture" onCancel={cancel}
      onPick={(point) => {
        const { editor } = getServices();
        const located = allElements(currentScene(editor.getState().doc).tracks).find((l) => l.element.id === target);
        const { scale, holdSeconds } = zoomPickStore.get();
        cancel();
        if (!located) return;
        const { width, height } = editor.getState().doc.settings.canvasSize;
        const playhead = editor.playback.getState().currentTime;
        const zoom = zoomAtPlayhead({
          at: Math.max(0, playhead - located.element.startTime), clipDuration: located.element.duration,
          point: { x: Math.round(point.x - width / 2), y: Math.round(point.y - height / 2) }, scale, holdSeconds,
        });
        if (!zoom) { toast.error("No room to zoom here", "Move the playhead earlier inside the clip, at least a fifth of a second before its end."); return; }
        runEdit(editor, autoZoomCommand({ ref: located.ref, zooms: [zoom] }));
      }} />
  );
}
