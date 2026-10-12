import { cloneElement, useCallback, useEffect, useId, useRef, useState, type ReactElement, type ReactNode } from "react";
import { createPortal } from "react-dom";

interface TooltipProps {
  content: ReactNode;
  side?: "top" | "bottom" | "right";
  delay?: number;
  children: ReactElement<{ onPointerEnter?: (e: React.PointerEvent) => void; onPointerLeave?: (e: React.PointerEvent) => void; onFocus?: (e: React.FocusEvent) => void; onBlur?: (e: React.FocusEvent) => void; "aria-describedby"?: string }>;
}

/** Hover/focus tooltip. Disabled buttons should be wrapped in a span by the caller so hover still fires. */
export function Tooltip({ content, side = "bottom", delay = 300, children }: TooltipProps): ReactNode {
  const id = useId();
  const [rect, setRect] = useState<DOMRect | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const target = useRef<HTMLElement | null>(null);

  const hide = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    setRect(null);
  }, []);
  const show = useCallback((el: HTMLElement) => {
    target.current = el;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setRect(el.getBoundingClientRect()), delay);
  }, [delay]);
  useEffect(() => hide, [hide]);

  const child = cloneElement(children, {
    onPointerEnter: (e) => { children.props.onPointerEnter?.(e); show(e.currentTarget as HTMLElement); },
    onPointerLeave: (e) => { children.props.onPointerLeave?.(e); hide(); },
    onFocus: (e) => { children.props.onFocus?.(e); if ((e.currentTarget as HTMLElement).matches(":focus-visible")) show(e.currentTarget as HTMLElement); },
    onBlur: (e) => { children.props.onBlur?.(e); hide(); },
    "aria-describedby": rect ? id : undefined,
  });

  const style = rect
    ? side === "right" ? { left: rect.right + 8, top: rect.top + rect.height / 2, transform: "translateY(-50%)" }
      : side === "top" ? { left: rect.left + rect.width / 2, top: rect.top - 6, transform: "translate(-50%, -100%)" }
      : rect.left + rect.width / 2 > window.innerWidth - 160 ? { right: Math.max(8, window.innerWidth - rect.right), top: rect.bottom + 6 }
      : { left: rect.left + rect.width / 2, top: rect.bottom + 6, transform: "translateX(-50%)" }
    : undefined;
  return (
    <>
      {child}
      {rect && style ? createPortal(<div role="tooltip" id={id} className="tooltip" style={style}>{content}</div>, document.body) : null}
    </>
  );
}
