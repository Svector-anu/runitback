import { useEffect, useRef, type ReactNode } from "react";
import "../styles/ctl.css";
import { NumberField } from "./fields";

export interface SliderFieldProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  /** Typed values may go beyond the slider's range (defaults to it). */
  inputMin?: number;
  inputMax?: number;
  defaultValue?: number;
  /** Display = value * multiplier (e.g. 100 for percent). */
  displayMultiplier?: number;
  suffix?: string;
  disabled?: boolean;
  /** Fired on every `input` while dragging or stepping; the caller shows it without recording history. */
  onPreview(value: number): void;
  /** Fired once per gesture: native `change` on release or after a key step, a typed value, or the reset button. */
  onCommit(value: number): void;
}

/** Range input plus numeric readout. A drag is `onPreview*` then one `onCommit`, so it is one undo step. */
export function SliderField(props: SliderFieldProps): ReactNode {
  const { label, value, min, max, step, disabled } = props;
  const range = useRef<HTMLInputElement>(null);
  const latest = useRef(props);
  latest.current = props;

  useEffect(() => {
    const el = range.current;
    if (!el) return undefined;
    const onChange = (): void => latest.current.onCommit(Number(el.value));
    el.addEventListener("change", onChange);
    return () => el.removeEventListener("change", onChange);
  }, []);

  const shown = Math.min(max, Math.max(min, value));
  const span = max - min;
  const percent = (v: number): number => (span > 0 ? ((v - min) / span) * 100 : 0);
  const origin = percent(Math.min(Math.max(0, min), max));
  const at = percent(shown);
  return (
    <div className="slider-field" data-disabled={disabled || undefined}>
      <input
        ref={range} type="range" className="slider slider-field__range" aria-label={`${label} slider`} min={min} max={max} step={step}
        value={shown} disabled={disabled} style={{ "--slider-from": `${Math.min(origin, at)}%`, "--slider-to": `${Math.max(origin, at)}%` } as React.CSSProperties}
        onChange={(e) => props.onPreview(Number(e.target.value))}
      />
      <NumberField
        label={label} value={value} min={props.inputMin ?? min} max={props.inputMax ?? max} step={step} defaultValue={props.defaultValue} displayMultiplier={props.displayMultiplier}
        suffix={props.suffix} disabled={disabled} onCommit={props.onCommit}
      />
    </div>
  );
}
