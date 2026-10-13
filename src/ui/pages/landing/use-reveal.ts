import { useLayoutEffect, type RefObject } from "react";

const REVEAL_LINE = 0.94;

/**
 * Scroll reveal. Marks the root as armed (hidden start state), then adds `is-in` to each `.zn-reveal` the first time
 * it enters the viewport. Anything the page has already scrolled past is revealed too: jump scrolls, anchors and
 * layout shifts skip elements without an intersection change, and content must never stay hidden.
 * Without IntersectionObserver or under reduced motion everything is simply visible.
 */
export function useReveal(root: RefObject<HTMLElement | null>): void {
  useLayoutEffect(() => {
    const element = root.current;
    if (!element) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduce || typeof IntersectionObserver === "undefined") return;
    const pending = new Set(Array.from(element.querySelectorAll<HTMLElement>(".zn-reveal")));
    const reveal = (target: HTMLElement): void => {
      target.classList.add("is-in");
      pending.delete(target);
      observer.unobserve(target);
    };
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) reveal(entry.target as HTMLElement);
      }
    }, { rootMargin: "0px 0px -6% 0px", threshold: 0.08 });
    for (const target of pending) observer.observe(target);

    let frame = 0;
    const sweep = (): void => {
      frame = 0;
      const line = window.innerHeight * REVEAL_LINE;
      for (const target of Array.from(pending)) {
        if (target.getBoundingClientRect().top < line) reveal(target);
      }
    };
    const onScroll = (): void => {
      if (frame === 0) frame = window.requestAnimationFrame(sweep);
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    element.dataset.reveal = "armed";
    return () => {
      window.removeEventListener("scroll", onScroll);
      if (frame !== 0) window.cancelAnimationFrame(frame);
      observer.disconnect();
      delete element.dataset.reveal;
    };
  }, [root]);
}
