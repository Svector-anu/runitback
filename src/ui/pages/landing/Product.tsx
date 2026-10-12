import { useEffect, useRef, useState, type ReactNode } from "react";
import { uiStore } from "#/app/ui-state";
import { LANDING_CONTENT } from "../landing-content";
import { SectionHead, stagger } from "./parts";

const { product } = LANDING_CONTENT;

/**
 * DEMO VIDEO SLOT. Drop an MP4 at public/landing/demo.mp4 and it appears here; while the file is missing or
 * unplayable the whole slot stays collapsed and the page is unaffected. See docs/LANDING.md.
 */
function DemoSlot(): ReactNode {
  const [ready, setReady] = useState(false);
  const video = useRef<HTMLVideoElement>(null);
  // The metadata event can fire before React attaches its listener (cached or fast responses), so also check on mount.
  useEffect(() => {
    if (video.current && video.current.readyState >= HTMLMediaElement.HAVE_METADATA) setReady(true);
  }, []);
  return (
    <figure className="lp-demo" data-ready={ready} aria-hidden={!ready}>
      <video
        ref={video}
        className="lp-demo__video"
        controls
        playsInline
        preload="metadata"
        poster={product.demo.poster}
        src={product.demo.src}
        aria-label={product.demo.caption}
        tabIndex={ready ? 0 : -1}
        onLoadedMetadata={() => setReady(true)}
        onError={() => setReady(false)}
      />
      <figcaption className="zn-mono">{product.demo.label}: {product.demo.caption}</figcaption>
    </figure>
  );
}

export function Product(): ReactNode {
  const theme = uiStore.use((s) => s.theme);
  const shot = theme === "dark" ? product.shotDark : product.shotLight;
  return (
    <section id="product" className="lp-section lp-wrap" aria-labelledby="product-title" tabIndex={-1}>
      <SectionHead index={2} eyebrow={product.eyebrow} title={product.title} intro={product.intro} titleId="product-title" />
      <div className="zn-frame lp-product zn-reveal" style={stagger(2)}>
        <div className="lp-window zn-surface">
          <div className="lp-window__bar">
            <span className="lp-window__dots" aria-hidden="true"><i /><i /><i /></span>
            <span className="lp-window__title zn-mono">{product.windowTitle}</span>
          </div>
          <img className="lp-window__shot" src={shot.src} alt={shot.alt} width={shot.width} height={shot.height} loading="lazy" decoding="async" />
        </div>
        <DemoSlot />
      </div>
    </section>
  );
}
