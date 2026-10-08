import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { useRegisterOverlay } from "./overlay-store";

export interface PopoverProps {
  open: boolean;
  onClose: () => void;
  /** Element the popover is anchored to. */
  anchor: RefObject<HTMLElement | null> | { x: number; y: number };
  align?: "start" | "end";
  className?: string;
  children: ReactNode;
  role?: string;
  label?: string;
}

const MARGIN = 8;

/** Positioned layer that closes on outside press and Escape, flipping to stay inside the viewport. */
export function Popover({ open, onClose, anchor, align = "start", className, children, role = "dialog", label }: PopoverProps): ReactNode {
  const ref = useRef<HTMLDivElement>(null);
  const [style, setStyle] = useState<CSSProperties>({ visibility: "hidden" });
  useRegisterOverlay(open);

  useLayoutEffect(() => {
    if (!open || !ref.current) return;
    const el = ref.current;
    const box = el.getBoundingClientRect();
    let left: number;
    let top: number;
    if ("x" in anchor) {
      left = anchor.x;
      top = anchor.y;
    } else {
      const a = anchor.current?.getBoundingClientRect();
      if (!a) return;
      left = align === "end" ? a.right - box.width : a.left;
      top = a.bottom + 4;
      if (top + box.height > window.innerHeight - MARGIN) top = Math.max(MARGIN, a.top - box.height - 4);
    }
    left = Math.min(Math.max(MARGIN, left), window.innerWidth - box.width - MARGIN);
    top = Math.min(Math.max(MARGIN, top), window.innerHeight - box.height - MARGIN);
    setStyle({ left, top, visibility: "visible" });
  }, [open, anchor, align]);

  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (e: PointerEvent): void => {
      const target = e.target as Node;
      if (ref.current?.contains(target)) return;
      if (!("x" in anchor) && anchor.current?.contains(target)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [open, onClose, anchor]);

  if (!open) return null;
  return createPortal(
    <div ref={ref} role={role} aria-label={label} className={["popover", className].filter(Boolean).join(" ")} style={style}>
      {children}
    </div>,
    document.body,
  );
}
