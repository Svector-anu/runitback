import type { CSSProperties, MouseEvent, ReactNode } from "react";
import type { SectionId } from "../landing-content";

export const APP_PATH = "/app";

export function startEditing(): void {
  location.assign(APP_PATH);
}

export function stagger(index: number): CSSProperties {
  return { "--zn-i": index } as CSSProperties;
}

export function scrollToSection(id: SectionId): void {
  const target = document.getElementById(id);
  if (!target) return;
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  target.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" });
  target.focus({ preventScroll: true });
}

/** Section links must not change location.hash: a non-empty hash on `/` switches the app shell away from the landing page. */
export function sectionLinkProps(id: SectionId, after?: () => void): { href: string; onClick: (event: MouseEvent<HTMLElement>) => void } {
  return {
    href: `#${id}`,
    onClick: (event) => {
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      scrollToSection(id);
      after?.();
    },
  };
}

export function ArrowUpRight({ size = 14 }: { size?: number }): ReactNode {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4.5 11.5 11.5 4.5M5.5 4.5h6v6" />
    </svg>
  );
}

export function ArrowDown(): ReactNode {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M8 3v10M3.5 8.5 8 13l4.5-4.5" />
    </svg>
  );
}

export function Check({ size = 14 }: { size?: number }): ReactNode {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="8" cy="8" r="6.25" />
      <path d="m5.4 8.2 1.8 1.8 3.4-3.7" />
    </svg>
  );
}

export function Eyebrow({ index, label }: { index: number; label: string }): ReactNode {
  return (
    <span className="zn-eyebrow">
      <i aria-hidden="true">/</i>{String(index).padStart(3, "0")}<i aria-hidden="true">/</i>{label}
    </span>
  );
}

export function SectionHead(props: { index: number; eyebrow: string; title: string; intro?: string; titleId: string }): ReactNode {
  return (
    <div className="lp-head">
      <div className="lp-head__main">
        <div className="zn-reveal"><Eyebrow index={props.index} label={props.eyebrow} /></div>
        <h2 className="zn-h2 zn-reveal" id={props.titleId} style={stagger(1)}>{props.title}</h2>
      </div>
      {props.intro ? <p className="zn-lead lp-head__intro zn-reveal" style={stagger(2)}>{props.intro}</p> : null}
    </div>
  );
}
