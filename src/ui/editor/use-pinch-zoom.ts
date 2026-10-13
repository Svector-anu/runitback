import { useEffect, type RefObject } from "react";

const MIN_DISTANCE_PX = 10;

const distance = (a: Touch, b: Touch): number => Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);

/**
 * Turns a two-finger pinch inside `host` into the ctrl+wheel zoom the timeline already understands, so zoom stays
 * anchored under the fingers and goes through the timeline's own clamping. Single-finger gestures are untouched.
 */
export function usePinchZoom(host: RefObject<HTMLElement | null>, targetSelector: string): void {
  useEffect(() => {
    const el = host.current;
    if (!el) return undefined;
    let last = 0;
    const onStart = (e: TouchEvent): void => {
      const [a, b] = [e.touches[0], e.touches[1]];
      last = e.touches.length === 2 && a && b ? distance(a, b) : 0;
    };
    const onMove = (e: TouchEvent): void => {
      const [a, b] = [e.touches[0], e.touches[1]];
      if (e.touches.length !== 2 || !a || !b || last < MIN_DISTANCE_PX) return;
      e.preventDefault();
      const now = distance(a, b);
      const target = el.querySelector(targetSelector);
      if (!target || now < MIN_DISTANCE_PX) return;
      // Spreading fingers (now > last) zooms in, which a ctrl+wheel expresses as a negative deltaY.
      const deltaY = -Math.log(now / last) * 300;
      last = now;
      target.dispatchEvent(new WheelEvent("wheel", {
        ctrlKey: true, deltaY, deltaMode: 0, clientX: (a.clientX + b.clientX) / 2, clientY: (a.clientY + b.clientY) / 2, bubbles: true, cancelable: true,
      }));
    };
    const onEnd = (e: TouchEvent): void => { last = e.touches.length === 2 ? last : 0; };
    el.addEventListener("touchstart", onStart, { passive: true });
    el.addEventListener("touchmove", onMove, { passive: false });
    el.addEventListener("touchend", onEnd, { passive: true });
    el.addEventListener("touchcancel", onEnd, { passive: true });
    return () => {
      el.removeEventListener("touchstart", onStart);
      el.removeEventListener("touchmove", onMove);
      el.removeEventListener("touchend", onEnd);
      el.removeEventListener("touchcancel", onEnd);
    };
  }, [host, targetSelector]);
}
