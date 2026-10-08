export interface PointerGestureHandlers {
  /** Called at most once per animation frame with the latest pointer event; always flushed before `up`. */
  move: (e: PointerEvent) => void;
  up: (e: PointerEvent) => void;
  /** The gesture was interrupted (pointercancel, window blur, lost capture): undo whatever it started. */
  cancel: () => void;
}

/**
 * Drives a window-level pointer gesture. Guarantees that exactly one of `up` / `cancel` runs and that the listeners
 * and the pending animation frame are gone afterwards, so a lost `pointerup` can never leave the editor stuck in
 * a scrub or drag. Returns a function that ends tracking without calling any handler (for Escape-driven cancels).
 */
export function trackPointerGesture(handlers: PointerGestureHandlers): () => void {
  let pending: PointerEvent | null = null;
  let frame = 0;
  let active = true;

  const flush = (): void => {
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
    const e = pending;
    pending = null;
    if (e) handlers.move(e);
  };
  const stop = (): void => {
    if (!active) return;
    active = false;
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
    pending = null;
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    window.removeEventListener("pointercancel", onCancel);
    window.removeEventListener("blur", onCancel);
  };
  const onMove = (e: PointerEvent): void => {
    pending = e;
    if (!frame) frame = requestAnimationFrame(() => { frame = 0; flush(); });
  };
  const onUp = (e: PointerEvent): void => {
    if (!active) return;
    flush();
    stop();
    handlers.up(e);
  };
  const onCancel = (): void => {
    if (!active) return;
    stop();
    handlers.cancel();
  };

  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
  window.addEventListener("pointercancel", onCancel);
  window.addEventListener("blur", onCancel);
  return stop;
}
