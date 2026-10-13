import type { ReactNode } from "react";
import { getTemplate } from "#/templates";
import { durationBadge, toCardData, type TemplateCardData } from "../../lib/template-gallery";
import { LANDING_CONTENT } from "../landing-content";
import { ArrowUpRight, SectionHead, stagger } from "./parts";

const { templates } = LANDING_CONTENT;

const FEATURED: TemplateCardData[] = templates.featured.flatMap((id) => {
  const template = getTemplate(id);
  return template ? [toCardData(template)] : [];
});

export function Templates(): ReactNode {
  return (
    <section id="templates" className="lp-section lp-wrap" aria-labelledby="templates-title" tabIndex={-1}>
      <SectionHead index={3} eyebrow={templates.eyebrow} title={templates.title} intro={templates.intro} titleId="templates-title" />
      <div className="zn-frame lp-tpl">
        <ul className="lp-tpl__grid">
          {FEATURED.map((card, index) => (
            <li key={card.id} className="lp-tpl__item zn-reveal" style={stagger(index)} data-template-id={card.id}>
              <a className="lp-tpl__card zn-surface" href="/templates" aria-label={`${card.name}, ${card.aspect}, ${durationBadge(card.durationSeconds)}. Browse templates`}>
                <span className="lp-tpl__media">
                  {card.poster ? <img src={card.poster} alt={`${card.name} template preview`} loading="lazy" decoding="async" /> : null}
                  <span className="lp-tpl__badge zn-mono">{durationBadge(card.durationSeconds)}</span>
                </span>
                <span className="lp-tpl__name">{card.name}</span>
                <span className="lp-tpl__meta zn-mono">{card.aspect}</span>
              </a>
            </li>
          ))}
        </ul>
        <div className="lp-tpl__foot">
          <p className="zn-mono lp-tpl__note">{templates.note}</p>
          <a className="zn-btn zn-btn--primary zn-btn--sm" href="/templates">{templates.cta}<span className="zn-btn__circle"><ArrowUpRight size={13} /></span></a>
        </div>
      </div>
    </section>
  );
}
