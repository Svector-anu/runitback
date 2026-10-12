import type { ReactNode } from "react";
import { LANDING_CONTENT } from "../landing-content";
import { stagger } from "./parts";

const { worksWith } = LANDING_CONTENT;

export function WorksWith(): ReactNode {
  return (
    <section className="lp-works" aria-label={worksWith.label}>
      <ul className="lp-works__row lp-wrap">
        <li className="lp-works__label zn-mono">{worksWith.label}</li>
        {worksWith.items.map((item, index) => (
          <li key={item.title} className="lp-works__cell zn-reveal" style={stagger(index)}>
            <strong>{item.title}</strong>
            <span className="zn-mono">{item.detail}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
