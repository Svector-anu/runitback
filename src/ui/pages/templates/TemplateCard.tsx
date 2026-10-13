import type { ReactNode } from "react";
import { categoryLabel, durationBadge, summaryLine, type TemplateCardData } from "../../lib/template-gallery";
import { GALLERY_COPY } from "./templates-content";

interface TemplateCardProps {
  card: TemplateCardData;
  playing: boolean;
  busy: boolean;
  disabled: boolean;
  observe: (element: HTMLElement | null) => void;
  onUse: () => void;
}

export function TemplateCard({ card, playing, busy, disabled, observe, onUse }: TemplateCardProps): ReactNode {
  const titleId = `tg-title-${card.id}`;
  return (
    <li className="tg-card" data-template-id={card.id} data-aspect={card.aspect.replace(":", "x")}>
      <article aria-labelledby={titleId} className="tg-card__inner">
        <div ref={observe} className="tg-media">
          {card.poster ? <img className="tg-media__poster" src={card.poster} alt="" loading="lazy" decoding="async" /> : null}
          {playing && card.video ? (
            <video
              className="tg-media__video" src={card.video} poster={card.poster ?? undefined} aria-hidden="true" tabIndex={-1}
              muted loop playsInline autoPlay preload="auto" data-testid="template-preview"
              ref={(video) => { if (video) video.muted = true; }}
            />
          ) : null}
          <span className="tg-badge tg-badge--aspect zn-mono">{card.aspect}</span>
          <span className="tg-badge tg-badge--time zn-mono">{durationBadge(card.durationSeconds)}</span>
        </div>
        <div className="tg-body">
          <h3 id={titleId} className="tg-name">{card.name}</h3>
          <p className="tg-desc">{card.description}</p>
          <ul className="tg-chips" aria-label="Category and tags">
            <li className="tg-chip tg-chip--category">{categoryLabel(card.category)}</li>
            {card.tags.slice(0, 2).map((tag) => <li key={tag} className="tg-chip">{tag}</li>)}
          </ul>
          <p className="tg-meta zn-mono">{summaryLine(card)}</p>
          <button type="button" className="zn-btn zn-btn--primary zn-btn--sm tg-use" disabled={disabled} aria-label={`${GALLERY_COPY.useLabel}: ${card.name}`} aria-busy={busy} onClick={onUse}>
            {busy ? "Opening..." : GALLERY_COPY.useLabel}
            <span className="zn-btn__circle" aria-hidden="true">
              <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M4.5 11.5 11.5 4.5M5.5 4.5h6v6" /></svg>
            </span>
          </button>
        </div>
      </article>
    </li>
  );
}
