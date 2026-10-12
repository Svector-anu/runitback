import type { ReactNode } from "react";
import { LANDING_CONTENT } from "../landing-content";
import { ArrowUpRight, sectionLinkProps, stagger, startEditing } from "./parts";

const { finalCta } = LANDING_CONTENT;

export function FinalCta(): ReactNode {
  return (
    <section className="lp-section lp-wrap" aria-labelledby="cta-title">
      <div className="zn-frame lp-cta">
        <div className="lp-cta__copy">
          <p className="zn-tag zn-reveal"><i className="zn-dot" aria-hidden="true" />{finalCta.status}</p>
          <h2 className="zn-h2 zn-reveal" id="cta-title" style={stagger(1)}>{finalCta.title}</h2>
          <p className="zn-lead zn-reveal" style={stagger(2)}>{finalCta.body}</p>
          <div className="lp-hero__ctas zn-reveal" style={stagger(3)}>
            <button type="button" className="zn-btn zn-btn--primary" onClick={startEditing}>{finalCta.primaryCta}<span className="zn-btn__circle"><ArrowUpRight /></span></button>
            <a className="zn-btn zn-btn--secondary" {...sectionLinkProps("faq")}>{finalCta.secondaryCta}</a>
          </div>
        </div>
        <figure className="lp-cta__shot zn-reveal" style={stagger(2)}>
          <img src={finalCta.image.src} alt={finalCta.image.alt} width={finalCta.image.width} height={finalCta.image.height} loading="lazy" decoding="async" style={{ objectPosition: finalCta.image.position }} />
        </figure>
      </div>
    </section>
  );
}
