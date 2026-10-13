import type { ReactNode } from "react";
import { LANDING_CONTENT } from "../landing-content";
import { Eyebrow, stagger } from "./parts";

const { how } = LANDING_CONTENT;

export function How(): ReactNode {
  return (
    <section id="how-it-works" className="lp-section lp-wrap lp-how" aria-label="How it works" tabIndex={-1}>
      <div className="lp-how__copy">
        <div className="zn-reveal"><Eyebrow index={5} label={how.eyebrow} /></div>
        <h2 className="zn-h2 zn-reveal" style={stagger(1)}>{how.title}</h2>
        <p className="zn-lead zn-reveal" style={stagger(2)}>{how.intro}</p>
      </div>
      <div className="zn-frame lp-how__frame">
        <ol className="lp-steps">
          {how.steps.map((step, index) => (
            <li key={step.title} className="lp-step zn-reveal" style={stagger(index)}>
              <span className="lp-step__no zn-mono" aria-hidden="true">{String(index + 1).padStart(2, "0")}</span>
              <div>
                <h3 className="zn-h3 lp-step__title">{step.title}</h3>
                <p className="lp-step__body">{step.body}</p>
              </div>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}
