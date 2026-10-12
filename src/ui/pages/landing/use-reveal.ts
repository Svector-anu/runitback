import { useLayoutEffect, type RefObject } from "react";

/**
 * Scroll reveal. Marks the root as armed (hidden start state), then adds `is-in` to each `.zn-reveal` the first time
 * it enters the viewport. Without IntersectionObserver or under reduced motion everything is simply visible.
 */
export function useReveal(root: RefObject<HTMLElement | null>): void {
  useLayoutEffect(() => {
    const element = root.current;
    if (!element) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduce || typeof IntersectionObserver === "undefined") return;
    const targets = Array.from(element.querySelectorAll<HTMLElement>(".zn-reveal"));
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        entry.target.classList.add("is-in");
        observer.unobserve(entry.target);
      }
    }, { rootMargin: "0px 0px -6% 0px", threshold: 0.08 });
    for (const target of targets) observer.observe(target);
    element.dataset.reveal = "armed";
    return () => {
      observer.disconnect();
      delete element.dataset.reveal;
    };
  }, [root]);
}
