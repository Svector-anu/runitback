import { Children, useCallback, useRef, useState, type ReactNode } from "react";
import { trackPointerGesture } from "../lib/pointer-gesture";

export interface PaneConstraint {
  min?: number;
  max?: number;
}

export interface SplitProps {
  direction: "row" | "column";
  /** Percent sizes, summing to 100. */
  sizes: number[];
  constraints: PaneConstraint[];
  onChange: (sizes: number[]) => void;
  children: ReactNode;
  label: string;
}

export function clampPair(input: { sizes: number[]; index: number; delta: number; constraints: PaneConstraint[] }): number[] {
  const { sizes, index, constraints } = input;
  const a = sizes[index] as number;
  const b = sizes[index + 1] as number;
  const ca = constraints[index] ?? {};
  const cb = constraints[index + 1] ?? {};
  const minDelta = Math.max((ca.min ?? 0) - a, b - (cb.max ?? 100));
  const maxDelta = Math.min((ca.max ?? 100) - a, b - (cb.min ?? 0));
  const delta = Math.min(maxDelta, Math.max(minDelta, input.delta));
  const next = [...sizes];
  next[index] = a + delta;
  next[index + 1] = b - delta;
  return next;
}

/** Resizable panes with pointer and keyboard handles; sizes are owned by the caller so they can be persisted. */
export function Split({ direction, sizes, constraints, onChange, children, label }: SplitProps): ReactNode {
  const panes = Children.toArray(children);
  const ref = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState<number | null>(null);

  const startDrag = useCallback((index: number, e: React.PointerEvent) => {
    e.preventDefault();
    const container = ref.current;
    if (!container) return;
    const total = direction === "row" ? container.clientWidth : container.clientHeight;
    const startPos = direction === "row" ? e.clientX : e.clientY;
    const startSizes = sizes;
    setDragging(index);
    const move = (ev: PointerEvent): void => {
      const pos = direction === "row" ? ev.clientX : ev.clientY;
      onChange(clampPair({ sizes: startSizes, index, delta: ((pos - startPos) / total) * 100, constraints }));
    };
    const end = (): void => setDragging(null);
    trackPointerGesture({ move, up: end, cancel: end });
  }, [direction, sizes, constraints, onChange]);

  const onKey = (index: number, e: React.KeyboardEvent): void => {
    const step = e.shiftKey ? 5 : 1;
    const back = direction === "row" ? "ArrowLeft" : "ArrowUp";
    const fwd = direction === "row" ? "ArrowRight" : "ArrowDown";
    if (e.key !== back && e.key !== fwd) return;
    e.preventDefault();
    onChange(clampPair({ sizes, index, delta: e.key === fwd ? step : -step, constraints }));
  };

  return (
    <div ref={ref} className={`split split--${direction}`} role="group" aria-label={label}>
      {panes.map((pane, i) => (
        <div key={i} style={{ display: "contents" }}>
          <div className="split__pane" style={{ flex: `${sizes[i]} 1 0%` }}>{pane}</div>
          {i < panes.length - 1 ? (
            <div
              className="split__handle" role="separator" tabIndex={0} aria-orientation={direction === "row" ? "vertical" : "horizontal"}
              aria-valuenow={Math.round(sizes[i] as number)} aria-valuemin={constraints[i]?.min ?? 0} aria-valuemax={constraints[i]?.max ?? 100}
              aria-label={`Resize ${label} panel ${i + 1}`} data-dragging={dragging === i}
              onPointerDown={(e) => startDrag(i, e)} onKeyDown={(e) => onKey(i, e)}
            />
          ) : null}
        </div>
      ))}
    </div>
  );
}
