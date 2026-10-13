import { useEffect, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { screenToCanvas, type PreviewView } from "./view";

/** Full-viewport capture layer for picking a point on the preview: one click reports the canvas point, Escape cancels. */
export function PickLayer({ view, label, testId, onPick, onCancel }: {
  view: PreviewView; label: string; testId: string; onPick: (point: { x: number; y: number }) => void; onCancel: () => void;
}): ReactNode {
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      onCancel();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onCancel]);
  const pick = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const rect = event.currentTarget.getBoundingClientRect();
    onPick(screenToCanvas(view, event.clientX - rect.left, event.clientY - rect.top));
  };
  return <div data-testid={testId} role="presentation" onPointerDown={pick} style={{ position: "absolute", inset: 0, zIndex: 30, cursor: "crosshair" }} aria-label={label} />;
}
