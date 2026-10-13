import { useEffect, useState, type ReactNode } from "react";
import { setTheme, uiStore } from "#/app/ui-state";
import { Icon } from "../../icons";
import { Logo } from "../../brand/Logo";
import { LANDING_CONTENT } from "../landing-content";
import { APP_PATH, ArrowUpRight, EXTERNAL_LINK_PROPS, StarIcon, sectionLinkProps } from "./parts";

const { nav, brand, github } = LANDING_CONTENT;

function ThemeButton({ className }: { className: string }): ReactNode {
  const theme = uiStore.use((s) => s.theme);
  const next = theme === "dark" ? "light" : "dark";
  return (
    <button type="button" className={`zn-icon-btn ${className}`} aria-label={`Switch to ${next} theme`} onClick={() => setTheme(next)}>
      <Icon name={theme === "dark" ? "sun" : "moon"} size={18} />
    </button>
  );
}

/** A plain link used instead of the landing's section anchors on pages that are not the landing (the /templates gallery). */
export interface PageLink { label: string; href: string; current?: boolean }

export function Nav({ pageLinks }: { pageLinks?: ReadonlyArray<PageLink> } = {}): ReactNode {
  const [open, setOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const onScroll = (): void => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent): void => { if (event.key === "Escape") setOpen(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <header className="lp-nav" data-scrolled={scrolled} data-open={open}>
      <div className="lp-nav__bar lp-wrap">
        <a className="lp-nav__brand" href="/" aria-label={`${brand} home`}><Logo variant="lockup" size={30} /></a>
        <nav className="lp-nav__links" aria-label="Page sections">
          {pageLinks
            ? pageLinks.map((link) => <a key={link.href} className="lp-nav__link" href={link.href} aria-current={link.current ? "page" : undefined}>{link.label}</a>)
            : nav.links.map((link) => <a key={link.target} className="lp-nav__link" {...sectionLinkProps(link.target)}>{link.label}</a>)}
        </nav>
        <div className="lp-nav__actions">
          <ThemeButton className="lp-nav__theme" />
          <a className="zn-btn zn-btn--secondary zn-btn--sm lp-nav__star" href={github.repo} aria-label={github.starLabel} {...EXTERNAL_LINK_PROPS}><StarIcon /><span>{github.starLabel}</span></a>
          <a className="zn-btn zn-btn--primary zn-btn--sm" href={APP_PATH}>{nav.cta}<span className="zn-btn__circle"><ArrowUpRight size={13} /></span></a>
          <button type="button" className="zn-icon-btn zn-icon-btn--ink lp-nav__menu" aria-expanded={open} aria-controls="lp-menu" aria-label={open ? "Close menu" : nav.menuLabel} onClick={() => setOpen(!open)}>
            <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
              {open ? <path d="m4.5 4.5 9 9m0-9-9 9" /> : <path d="M3 6h12M3 12h12" />}
            </svg>
          </button>
        </div>
      </div>
      {open ? (
        <div className="lp-wrap lp-menu-wrap">
          <nav id="lp-menu" className="lp-menu zn-surface" aria-label="Menu">
            {pageLinks
              ? pageLinks.map((link) => <a key={link.href} className="lp-menu__link" href={link.href} aria-current={link.current ? "page" : undefined}>{link.label}</a>)
              : nav.links.map((link) => <a key={link.target} className="lp-menu__link" {...sectionLinkProps(link.target, () => setOpen(false))}>{link.label}</a>)}
            <a className="lp-menu__link lp-menu__star" href={github.repo} {...EXTERNAL_LINK_PROPS}><StarIcon size={18} />{github.starLabel}</a>
            <div className="lp-menu__row"><span className="zn-mono">Theme</span><ThemeButton className="lp-menu__theme" /></div>
          </nav>
        </div>
      ) : null}
    </header>
  );
}
