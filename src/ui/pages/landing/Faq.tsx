import { useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { LANDING_CONTENT } from "../landing-content";
import { APP_PATH, ArrowUpRight, EXTERNAL_LINK_PROPS, SectionHead, stagger } from "./parts";

const { faq } = LANDING_CONTENT;

function Toggle({ open }: { open: boolean }): ReactNode {
  return (
    <span className="lp-faq__toggle" aria-hidden="true">
      <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
        <path d="M2.5 7h9" />
        {open ? null : <path d="M7 2.5v9" />}
      </svg>
    </span>
  );
}

export function Faq(): ReactNode {
  const [openIndex, setOpenIndex] = useState<number | null>(0);
  const triggers = useRef<Array<HTMLButtonElement | null>>([]);

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number): void => {
    const last = faq.items.length - 1;
    const target = event.key === "ArrowDown" ? (index === last ? 0 : index + 1)
      : event.key === "ArrowUp" ? (index === 0 ? last : index - 1)
      : event.key === "Home" ? 0
      : event.key === "End" ? last
      : null;
    if (target === null) return;
    event.preventDefault();
    triggers.current[target]?.focus();
  };

  return (
    <section id="faq" className="lp-section lp-wrap" aria-labelledby="faq-title" tabIndex={-1}>
      <SectionHead index={9} eyebrow={faq.eyebrow} title={faq.title} titleId="faq-title" />
      <div className="zn-frame lp-faq">
        <div className="lp-faq__list">
          {faq.items.map((item, index) => {
            const open = openIndex === index;
            return (
              <div key={item.question} className={`lp-faq__item zn-reveal${open ? " is-open" : ""}`} style={stagger(index % 4)}>
                <h3 className="lp-faq__q">
                  <button
                    type="button"
                    id={`faq-q-${index}`}
                    ref={(node) => { triggers.current[index] = node; }}
                    aria-expanded={open}
                    aria-controls={`faq-a-${index}`}
                    onClick={() => setOpenIndex(open ? null : index)}
                    onKeyDown={(event) => onKeyDown(event, index)}
                  >
                    <span className="lp-faq__no zn-mono" aria-hidden="true">{String(index + 1).padStart(2, "0")}</span>
                    <span className="lp-faq__text">{item.question}</span>
                    <Toggle open={open} />
                  </button>
                </h3>
                <div id={`faq-a-${index}`} className="lp-faq__panel" role="region" aria-labelledby={`faq-q-${index}`}>
                  <div><p>{item.answer}{item.link ? <> <a href={item.link.href} {...EXTERNAL_LINK_PROPS}>{item.link.label}</a></> : null}</p></div>
                </div>
              </div>
            );
          })}
        </div>
        <aside className="lp-faq__aside zn-surface zn-reveal" style={stagger(2)} aria-label={faq.aside.title}>
          <h3 className="zn-h3">{faq.aside.title}</h3>
          <p className="zn-lead">{faq.aside.body}</p>
          <a className="zn-btn zn-btn--primary" href={APP_PATH}>{faq.aside.cta}<span className="zn-btn__circle"><ArrowUpRight /></span></a>
        </aside>
      </div>
    </section>
  );
}
