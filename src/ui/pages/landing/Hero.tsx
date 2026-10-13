import type { CSSProperties, ReactNode } from "react";
import { LANDING_CONTENT } from "../landing-content";
import { ArrowUpRight, Check, EXTERNAL_LINK_PROPS, StarIcon, stagger, startEditing } from "./parts";

const { hero, github } = LANDING_CONTENT;

export function Hero(): ReactNode {
  return (
    <section className="lp-hero lp-wrap" aria-label="Introduction">
      <div className="lp-hero__frame zn-frame">
        <div className="lp-hero__copy">
          <p className="zn-tag zn-reveal"><i className="zn-dot" aria-hidden="true" />{hero.status}</p>
          <h1 className="zn-h1 lp-hero__title zn-reveal" style={stagger(1)}><span className="lp-hero__kicker">{hero.kicker}</span> {hero.headline}</h1>
          <p className="zn-lead lp-hero__sub zn-reveal" style={stagger(2)}>{hero.sub}</p>
          <div className="lp-hero__ctas zn-reveal" style={stagger(3)}>
            <button type="button" className="zn-btn zn-btn--primary" onClick={startEditing}>{hero.primaryCta}<span className="zn-btn__circle"><ArrowUpRight /></span></button>
            <a className="zn-btn zn-btn--secondary lp-star" href={github.repo} {...EXTERNAL_LINK_PROPS}><StarIcon />{hero.githubCta}</a>
          </div>
          <a className="lp-hero__tlink zn-reveal" style={stagger(3)} href="/templates">{hero.templatesCta}<ArrowUpRight size={13} /></a>
          <ul className="lp-trust zn-reveal" style={stagger(4)} aria-label="Why it is safe to try">
            {hero.trust.map((item) => <li key={item}><Check size={13} />{item}</li>)}
          </ul>
        </div>
        <ul className="lp-strip zn-reveal" style={stagger(5)} aria-label="Product screenshots">
          {hero.strip.map((shot) => (
            <li key={shot.src} className="lp-strip__card" style={{ "--ratio": shot.ratio ?? 1.5 } as CSSProperties}>
              <img src={shot.src} alt={shot.alt} width={shot.width} height={shot.height} decoding="async" style={{ objectPosition: shot.position }} />
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
