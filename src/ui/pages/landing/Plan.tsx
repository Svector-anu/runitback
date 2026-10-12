import type { ReactNode } from "react";
import { LANDING_CONTENT } from "../landing-content";
import { Check, Eyebrow, stagger } from "./parts";

const { plan } = LANDING_CONTENT;

export function Plan(): ReactNode {
  return (
    <section className="lp-section lp-wrap" aria-labelledby="plan-title">
      <div className="zn-dark lp-plan">
        <div className="lp-plan__copy">
          <div className="zn-reveal"><Eyebrow index={5} label={plan.eyebrow} /></div>
          <h2 className="zn-h2 zn-reveal" id="plan-title" style={stagger(1)}>{plan.title}</h2>
          <ul className="lp-plan__points">
            {plan.points.map((point, index) => <li key={point} className="zn-reveal" style={stagger(index + 2)}><Check size={16} /><span>{point}</span></li>)}
          </ul>
        </div>
        <figure className="lp-plan__shot zn-reveal" style={stagger(2)}>
          <img src={plan.image.src} alt={plan.image.alt} width={plan.image.width} height={plan.image.height} loading="lazy" decoding="async" style={{ objectPosition: plan.image.position }} />
        </figure>
      </div>
    </section>
  );
}
