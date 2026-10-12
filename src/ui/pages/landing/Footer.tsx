import type { ReactNode } from "react";
import { Logo } from "../../brand/Logo";
import { LANDING_CONTENT } from "../landing-content";
import { APP_PATH, ArrowUpRight, sectionLinkProps } from "./parts";

const { footer } = LANDING_CONTENT;

export function Footer(): ReactNode {
  return (
    <footer className="lp-footer lp-wrap">
      <div className="zn-frame lp-footer__frame">
        <div className="lp-footer__brand">
          <Logo variant="lockup" size={30} />
          <p className="lp-footer__tagline">{footer.tagline}</p>
          <p className="zn-mono">{footer.note}</p>
        </div>
        {footer.columns.map((column) => (
          <nav key={column.title} className="lp-footer__col" aria-label={column.title}>
            <p className="lp-footer__title">{column.title}</p>
            <ul>
              {column.links.map((link) => (
                <li key={link.label}>{link.target ? <a {...sectionLinkProps(link.target)}>{link.label}</a> : <a href={link.href}>{link.label}</a>}</li>
              ))}
            </ul>
          </nav>
        ))}
        <aside className="lp-footer__card zn-surface" aria-label={footer.card.title}>
          <p className="lp-footer__card-title">{footer.card.title}</p>
          <p className="lp-footer__card-body">{footer.card.body}</p>
          <a className="zn-btn zn-btn--primary" href={APP_PATH}>{footer.card.cta}<span className="zn-btn__circle"><ArrowUpRight /></span></a>
        </aside>
      </div>
      <p className="lp-footer__legal zn-mono">&copy; {new Date().getFullYear()} {footer.legal}</p>
    </footer>
  );
}
