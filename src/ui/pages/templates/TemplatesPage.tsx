import { useEffect, useMemo, useState, type ReactNode } from "react";
import "../../styles/zenon-tokens.css";
import "../../styles/landing.css";
import "../../styles/templates.css";
import { navigateToApp } from "#/app/router";
import { getServices } from "#/app/services";
import { isBoolean } from "#/platform/prefs";
import { listTemplates } from "#/templates";
import { categoriesOf, categoryLabel, filterCards, previewsPaused, toCardData, type CategoryFilter } from "../../lib/template-gallery";
import { toast } from "../../primitives/toast";
import { Logo } from "../../brand/Logo";
import { Nav, type PageLink } from "../landing/Nav";
import { EXTERNAL_LINK_PROPS } from "../landing/parts";
import { LANDING_CONTENT } from "../landing-content";
import { Inspiration } from "./Inspiration";
import { TemplateCard } from "./TemplateCard";
import { GALLERY_COPY } from "./templates-content";
import { useReducedMotion, usePreviewPlayback } from "./use-preview-playback";

const PAUSED_PREF = "templates-previews-paused";
const PAGE_LINKS: ReadonlyArray<PageLink> = [
  { label: "Home", href: "/" },
  { label: "Templates", href: "/templates", current: true },
];
const CARDS = listTemplates().map(toCardData);
const CATEGORIES = categoriesOf(CARDS);

export function TemplatesPage(): ReactNode {
  const [category, setCategory] = useState<CategoryFilter>("all");
  const [query, setQuery] = useState("");
  const [pausedPref, setPausedPref] = useState<boolean>(() => getServices().prefs.read(PAUSED_PREF, false, isBoolean));
  const [busyId, setBusyId] = useState<string | null>(null);
  const reducedMotion = useReducedMotion();
  const paused = previewsPaused({ pausedPref, reducedMotion });

  const visible = useMemo(() => filterCards(CARDS, { category, query }), [category, query]);
  const order = useMemo(() => visible.map((card) => card.id), [visible]);
  const { playing, observe } = usePreviewPlayback(order, !paused);
  const filtered = category !== "all" || query.trim() !== "";

  useEffect(() => {
    const previous = document.title;
    document.title = "Templates | RunItBack";
    return () => { document.title = previous; };
  }, []);

  const togglePaused = (): void => {
    const next = !pausedPref;
    setPausedPref(next);
    getServices().prefs.write(PAUSED_PREF, next);
  };

  const useTemplate = async (id: string, name: string): Promise<void> => {
    setBusyId(id);
    try {
      const project = await getServices().projects.create(name);
      navigateToApp(`/editor/${project.metadata.id}?template=${encodeURIComponent(id)}`);
    } catch (error) {
      setBusyId(null);
      toast.error("Could not start a project", error instanceof Error ? error.message : undefined);
    }
  };

  return (
    <div className="zn lp tg">
      <a className="lp-skip" href="#main" onClick={(event) => { event.preventDefault(); document.getElementById("main")?.focus(); }}>Skip to content</a>
      <Nav pageLinks={PAGE_LINKS} />
      <main id="main" tabIndex={-1}>
        <header className="tg-head lp-wrap">
          <p className="zn-eyebrow"><i aria-hidden="true">/</i>{GALLERY_COPY.eyebrow}</p>
          <h1 className="zn-h1 tg-title">{GALLERY_COPY.title}</h1>
          <p className="zn-lead tg-lead">{GALLERY_COPY.lead}</p>
        </header>

        <section className="tg-toolbar lp-wrap" aria-label={GALLERY_COPY.toolbarLabel}>
          <div className="tg-chipbar" role="group" aria-label="Category">
            <button type="button" className="tg-filter" aria-pressed={category === "all"} onClick={() => setCategory("all")}>{GALLERY_COPY.allLabel}</button>
            {CATEGORIES.map((value) => (
              <button key={value} type="button" className="tg-filter" aria-pressed={category === value} onClick={() => setCategory(value)}>{categoryLabel(value)}</button>
            ))}
          </div>
          <div className="tg-tools">
            <label className="tg-search">
              <span className="tg-sr">{GALLERY_COPY.searchLabel}</span>
              <input type="search" value={query} placeholder={GALLERY_COPY.searchPlaceholder} onChange={(event) => setQuery(event.target.value)} />
            </label>
            <button type="button" className="tg-toggle" aria-pressed={paused} disabled={reducedMotion} onClick={togglePaused}
              title={reducedMotion ? GALLERY_COPY.pausedByMotionNote : undefined}>
              <span className="tg-toggle__track" aria-hidden="true"><i /></span>
              {GALLERY_COPY.pauseLabel}
            </button>
          </div>
          <p className="tg-count zn-mono" role="status" aria-live="polite">
            {visible.length} {visible.length === 1 ? "template" : "templates"}{reducedMotion ? `. ${GALLERY_COPY.pausedByMotionNote}` : ""}
          </p>
        </section>

        <section className="lp-wrap tg-gridwrap" aria-label="Templates">
          {visible.length > 0 ? (
            <ul className="tg-grid" data-testid="template-grid">
              {visible.map((card) => (
                <TemplateCard key={card.id} card={card} playing={playing.has(card.id)} busy={busyId === card.id} disabled={busyId !== null}
                  observe={observe(card.id)} onUse={() => void useTemplate(card.id, card.name)} />
              ))}
            </ul>
          ) : (
            <div className="tg-empty zn-frame" role="status">
              <h2 className="zn-h3">{GALLERY_COPY.emptyTitle}</h2>
              <p>{GALLERY_COPY.emptyBody}</p>
              {filtered ? <button type="button" className="zn-btn zn-btn--secondary zn-btn--sm" onClick={() => { setCategory("all"); setQuery(""); }}>{GALLERY_COPY.clearFilter}</button> : null}
            </div>
          )}
        </section>

        <div className="lp-wrap tg-inspowrap"><Inspiration /></div>
      </main>
      <footer className="tg-footer lp-wrap">
        <div className="tg-footer__row">
          <a className="tg-footer__brand" href="/" aria-label={`${LANDING_CONTENT.brand} home`}><Logo variant="lockup" size={26} /></a>
          <p className="zn-mono">{LANDING_CONTENT.footer.note}</p>
          <a className="tg-footer__link" href={`${LANDING_CONTENT.github.repo}/blob/main/docs/TEMPLATES.md`} {...EXTERNAL_LINK_PROPS}>How templates work</a>
        </div>
      </footer>
    </div>
  );
}
