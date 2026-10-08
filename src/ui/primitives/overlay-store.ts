import { useEffect, useSyncExternalStore } from "react";

let depth = 0;
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

/** Number of open dialogs/menus; global shortcuts are suspended while it is above zero. */
export function getOverlayDepth(): number {
  return depth;
}

export function useOverlayDepth(): number {
  return useSyncExternalStore((l) => {
    listeners.add(l);
    return () => listeners.delete(l);
  }, getOverlayDepth);
}

export function useRegisterOverlay(open: boolean): void {
  useEffect(() => {
    if (!open) return undefined;
    depth++;
    emit();
    return () => {
      depth--;
      emit();
    };
  }, [open]);
}
