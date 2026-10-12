import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { TOUR_STEPS, getTourStore, useTour, type TourStep } from "../lib/tour";
import { Button } from "../primitives/Button";
import { useRegisterOverlay } from "../primitives/overlay-store";
import { chooseSide, placeCard, type Box, type Side } from "./placement";

const PREFERRED_SIDE: Record<TourStep["target"], Side> = { import: "right", understand: "right", agent: "left", timeline: "above", export: "below" };

function toBox(rect: DOMRect): Box {
  return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
}

/** Non-blocking coach marks. The page stays usable; Esc, Back, Next and Skip are all keyboard reachable. */
export function Tour(): ReactNode {
  const { open, step: index } = useTour();
  const store = getTourStore();
  const cardRef = useRef<HTMLDivElement>(null);
  const nextRef = useRef<HTMLButtonElement>(null);
  const focusedStep = useRef<number | null>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const [layout, setLayout] = useState<{ target: Box | null; left: number; top: number } | null>(null);
  const step = TOUR_STEPS[index];
  useRegisterOverlay(open);

  useEffect(() => {
    if (!open) return undefined;
    returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    return () => {
      const el = returnFocus.current;
      if (el?.isConnected && el !== document.body) el.focus({ preventScroll: true });
    };
  }, [open]);

  useLayoutEffect(() => {
    if (!open || !step) return undefined;
    const measure = (): void => {
      const card = cardRef.current;
      if (!card) return;
      const size = { left: 0, top: 0, width: card.offsetWidth, height: card.offsetHeight };
      const viewport = { width: window.innerWidth, height: window.innerHeight };
      const rect = document.querySelector(`[data-tour="${step.target}"]`)?.getBoundingClientRect();
      if (!rect || rect.width === 0) {
        setLayout({ target: null, left: Math.max(8, (viewport.width - size.width) / 2), top: Math.max(8, viewport.height - size.height - 24) });
        return;
      }
      const target = toBox(rect);
      const side = chooseSide({ target, card: size, viewport, preferred: PREFERRED_SIDE[step.target] });
      setLayout({ target, ...placeCard({ target, card: size, viewport, side }) });
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [open, step]);

  const ready = layout !== null;
  useEffect(() => {
    if (!open) { focusedStep.current = null; return; }
    if (!ready || focusedStep.current === index) return;
    focusedStep.current = index;
    nextRef.current?.focus({ preventScroll: true });
  }, [open, index, ready]);

  if (!open || !step) return null;

  const last = index === TOUR_STEPS.length - 1;
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    if (e.key === "Escape") { e.stopPropagation(); store.close(); }
    else if (e.key === "ArrowRight") { e.preventDefault(); store.next(); }
    else if (e.key === "ArrowLeft") { e.preventDefault(); store.back(); }
  };

  return createPortal(
    <>
      {layout?.target ? (
        <div className="tour__ring" aria-hidden="true" style={{ left: layout.target.left - 4, top: layout.target.top - 4, width: layout.target.width + 8, height: layout.target.height + 8 }} />
      ) : null}
      <div
        ref={cardRef} className="tour" role="dialog" aria-modal="false" aria-labelledby="tour-title" aria-describedby="tour-body" data-testid="tour"
        data-step={step.target} onKeyDown={onKeyDown} style={layout ? { left: layout.left, top: layout.top } : { visibility: "hidden" }}
      >
        <div className="tour__progress" aria-hidden="true">{TOUR_STEPS.map((s, i) => <span key={s.target} data-active={i === index} data-done={i < index} />)}</div>
        <h2 id="tour-title" className="tour__title">{step.title}</h2>
        <p id="tour-body" className="tour__body">{step.body}</p>
        <div className="tour__footer">
          <span className="tour__count">{index + 1} of {TOUR_STEPS.length}</span>
          <div className="tour__actions">
            <Button variant="text" size="sm" onClick={() => store.close()}>{last ? "Close" : "Skip tour"}</Button>
            {index > 0 ? <Button variant="outline" size="sm" onClick={() => store.back()}>Back</Button> : null}
            <Button ref={nextRef} size="sm" onClick={() => store.next()}>{last ? "Done" : "Next"}</Button>
          </div>
        </div>
      </div>
    </>,
    document.body,
  );
}
