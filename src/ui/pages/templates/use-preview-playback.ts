import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { pickPlaying } from "../../lib/template-gallery";

const REDUCED_MOTION = "(prefers-reduced-motion: reduce)";

export function useReducedMotion(): boolean {
  return useSyncExternalStore(
    (notify) => {
      const query = window.matchMedia(REDUCED_MOTION);
      query.addEventListener("change", notify);
      return () => query.removeEventListener("change", notify);
    },
    () => window.matchMedia(REDUCED_MOTION).matches,
    () => false,
  );
}

/**
 * Tracks which cards are on screen and returns the ids whose preview video may play: at most `limit`, first in gallery
 * order. Cards register through `observe(id)`, which returns a ref callback. With `enabled` false nothing plays.
 */
export function usePreviewPlayback(order: ReadonlyArray<string>, enabled: boolean, limit?: number): {
  playing: ReadonlySet<string>;
  observe: (id: string) => (element: HTMLElement | null) => void;
} {
  const [visible, setVisible] = useState<ReadonlySet<string>>(new Set());
  const observer = useRef<IntersectionObserver | null>(null);
  const ids = useRef(new Map<Element, string>());

  useEffect(() => {
    if (typeof IntersectionObserver === "undefined") return undefined;
    const created = new IntersectionObserver((entries) => {
      setVisible((previous) => {
        const next = new Set(previous);
        for (const entry of entries) {
          const id = ids.current.get(entry.target);
          if (!id) continue;
          if (entry.isIntersecting) next.add(id);
          else next.delete(id);
        }
        return next;
      });
    }, { threshold: 0.4 });
    observer.current = created;
    for (const element of ids.current.keys()) created.observe(element);
    return () => {
      created.disconnect();
      observer.current = null;
    };
  }, []);

  const callbacks = useRef(new Map<string, (element: HTMLElement | null) => void>());
  // One stable ref callback per id: a new function every render would detach and re-attach every card on each update.
  const observe = useCallback((id: string) => {
    const cached = callbacks.current.get(id);
    if (cached) return cached;
    const register = (element: HTMLElement | null): void => {
      if (element) {
        ids.current.set(element, id);
        observer.current?.observe(element);
        return;
      }
      for (const [known, knownId] of ids.current) {
        if (knownId !== id) continue;
        observer.current?.unobserve(known);
        ids.current.delete(known);
      }
      setVisible((previous) => {
        if (!previous.has(id)) return previous;
        const next = new Set(previous);
        next.delete(id);
        return next;
      });
    };
    callbacks.current.set(id, register);
    return register;
  }, []);

  const playing = useMemo(() => (enabled ? pickPlaying(order, visible, limit) : new Set<string>()), [enabled, order, visible, limit]);
  return { playing, observe };
}
