import { useEffect, useRef, type ReactNode } from "react";
import "../../styles/zenon-tokens.css";
import "../../styles/landing.css";
import { Faq } from "./Faq";
import { Features } from "./Features";
import { FinalCta } from "./FinalCta";
import { Compare } from "./Compare";
import { Footer } from "./Footer";
import { Hero } from "./Hero";
import { How } from "./How";
import { Nav } from "./Nav";
import { OpenSource } from "./OpenSource";
import { Plan } from "./Plan";
import { Product } from "./Product";
import { WorksWith } from "./WorksWith";
import { useReveal } from "./use-reveal";

/**
 * Section order is the order of the elements below: remove a line to remove a section, move a line to move it.
 * All copy lives in ../landing-content.ts.
 */
export function LandingPage(): ReactNode {
  const root = useRef<HTMLDivElement>(null);
  useReveal(root);

  useEffect(() => {
    // `/` is a real pathname and anchors never touch the hash, so smooth scrolling is safe to scope to this page.
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduce) return;
    const html = document.documentElement;
    const previous = html.style.scrollBehavior;
    html.style.scrollBehavior = "smooth";
    return () => { html.style.scrollBehavior = previous; };
  }, []);

  return (
    <div ref={root} className="zn lp">
      <a className="lp-skip" href="#main" onClick={(event) => { event.preventDefault(); document.getElementById("main")?.focus(); }}>Skip to content</a>
      <Nav />
      <main id="main" tabIndex={-1}>
        <Hero />
        <WorksWith />
        <Product />
        <Features />
        <How />
        <Plan />
        <Compare />
        <OpenSource />
        <Faq />
        <FinalCta />
      </main>
      <Footer />
    </div>
  );
}
