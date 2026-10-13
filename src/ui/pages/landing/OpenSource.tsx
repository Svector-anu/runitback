import type { ReactNode } from "react";
import { LANDING_CONTENT } from "../landing-content";
import { ArrowUpRight, EXTERNAL_LINK_PROPS, SectionHead, StarIcon, stagger } from "./parts";

const { openSource, github, license } = LANDING_CONTENT;

export function OpenSource(): ReactNode {
  return (
    <section id="open-source" className="lp-section lp-wrap" aria-labelledby="open-source-title" tabIndex={-1}>
      <SectionHead index={7} eyebrow={openSource.eyebrow} title={openSource.title} intro={openSource.intro} titleId="open-source-title" />
      <div className="lp-os">
        <ul className="lp-os__parts zn-frame" aria-label={openSource.openLabel}>
          {openSource.parts.map((part, index) => (
            <li key={part.title} className="lp-os__part zn-surface zn-reveal" style={stagger(index)}>
              <h3 className="zn-h3">{part.title}</h3>
              <p>{part.body}</p>
            </li>
          ))}
        </ul>
        <aside className="lp-os__help zn-dark zn-reveal" style={stagger(1)} aria-label={openSource.contribute.title}>
          <a className="lp-os__badge zn-mono" href={license.url} {...EXTERNAL_LINK_PROPS}>{license.badge}</a>
          <h3 className="zn-h3">{openSource.contribute.title}</h3>
          <p>{openSource.contribute.body}</p>
          <a className="zn-btn zn-btn--light" href={github.repo} {...EXTERNAL_LINK_PROPS}><StarIcon />{github.starLabel}<span className="zn-btn__circle"><ArrowUpRight /></span></a>
        </aside>
      </div>
    </section>
  );
}
