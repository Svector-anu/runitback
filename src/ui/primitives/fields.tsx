import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Icon, type IconName } from "../icons";
import { evaluateExpression, pixelsPerUnit } from "../lib/expression";

export function formatNumber(value: number, step: number): string {
  const digits = Math.min(6, (String(step).split(".")[1] ?? "").length);
  return String(Number(value.toFixed(Math.max(digits, 2))));
}

export interface NumberFieldProps {
  value: number;
  defaultValue?: number;
  min?: number;
  max?: number;
  step?: number;
  /** Display = value * multiplier (e.g. 100 for percent). */
  displayMultiplier?: number;
  suffix?: string;
  icon?: IconName;
  label: string;
  disabled?: boolean;
  /** Pixels per unit while scrubbing the icon; piecewise ranges allow finer control at low values. */
  scrub?: { ranges?: ReadonlyArray<{ upTo: number; pxPerUnit: number }>; pxPerUnit: number };
  onPreview?: (value: number) => void;
  onCommit: (value: number) => void;
  onCancel?: () => void;
}

export function NumberField(props: NumberFieldProps): ReactNode {
  const { value, min, max, step = 1, displayMultiplier = 1, label } = props;
  const [draft, setDraft] = useState<string | null>(null);
  const scrubState = useRef<{ startX: number; startValue: number; last: number; moved: boolean } | null>(null);
  const id = useId();

  const clamp = useCallback((v: number): number => {
    let out = v;
    if (min !== undefined) out = Math.max(min, out);
    if (max !== undefined) out = Math.min(max, out);
    if (step > 0) out = Number((Math.round(out / step) * step).toFixed(6));
    return out;
  }, [min, max, step]);

  const commitText = (text: string): void => {
    const parsed = evaluateExpression(text);
    setDraft(null);
    if (parsed === null || !Number.isFinite(parsed)) return;
    const next = clamp(parsed / displayMultiplier);
    if (next !== value) props.onCommit(next);
  };

  const onScrubDown = (e: React.PointerEvent<HTMLButtonElement>): void => {
    if (!props.scrub || props.disabled) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    scrubState.current = { startX: e.clientX, startValue: value, last: value, moved: false };
  };
  const onScrubMove = (e: React.PointerEvent<HTMLButtonElement>): void => {
    const s = scrubState.current;
    if (!s || !props.scrub) return;
    const dx = e.clientX - s.startX;
    if (!s.moved && Math.abs(dx) < 2) return;
    s.moved = true;
    const px = props.scrub.ranges ? pixelsPerUnit(s.startValue, props.scrub.ranges, props.scrub.pxPerUnit) : props.scrub.pxPerUnit;
    s.last = clamp(s.startValue + dx / px);
    props.onPreview?.(s.last);
  };
  const onScrubUp = (e: React.PointerEvent<HTMLButtonElement>): void => {
    const s = scrubState.current;
    scrubState.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    if (!s?.moved) return;
    if (s.last !== s.startValue) props.onCommit(s.last);
    else props.onCancel?.();
  };

  const shown = draft ?? formatNumber(value * displayMultiplier, step * displayMultiplier);
  const showReset = props.defaultValue !== undefined && Math.abs(value - props.defaultValue) > 1e-9;
  const iconNode = props.icon ? <Icon name={props.icon} /> : null;

  return (
    <div className="number-field" data-disabled={props.disabled || undefined}>
      {iconNode && props.scrub ? (
        <button type="button" tabIndex={-1} aria-hidden="true" className="number-field__icon number-field__icon--scrub"
          onPointerDown={onScrubDown} onPointerMove={onScrubMove} onPointerUp={onScrubUp} onPointerCancel={onScrubUp}>{iconNode}</button>
      ) : iconNode ? <span className="number-field__icon">{iconNode}</span> : null}
      <input
        id={id} aria-label={label} type="text" inputMode="decimal" disabled={props.disabled} value={shown}
        onFocus={(e) => { setDraft(formatNumber(value * displayMultiplier, step * displayMultiplier)); e.currentTarget.select(); }}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={(e) => { if (draft !== null) commitText(e.target.value); }}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
          else if (e.key === "Escape") { setDraft(null); e.currentTarget.blur(); }
          else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
            e.preventDefault();
            const dir = e.key === "ArrowUp" ? 1 : -1;
            const next = clamp(value + dir * step * (e.shiftKey ? 10 : 1));
            if (next !== value) props.onCommit(next);
            setDraft(null);
          }
        }}
      />
      {props.suffix ? <span className="number-field__suffix">{props.suffix}</span> : null}
      {showReset ? (
        <button type="button" className="number-field__reset" aria-label={`Reset ${label}`} onClick={() => props.onCommit(props.defaultValue as number)}>
          <Icon name="reset" />
        </button>
      ) : null}
    </div>
  );
}

export function Switch({ checked, onChange, label, disabled }: { checked: boolean; onChange: (checked: boolean) => void; label: string; disabled?: boolean }): ReactNode {
  return <button type="button" role="switch" aria-checked={checked} aria-label={label} disabled={disabled} className="switch" onClick={() => onChange(!checked)} />;
}

export function ColorField({ value, onChange, onPreview, label }: { value: string; onChange: (v: string) => void; onPreview?: (v: string) => void; label: string }): ReactNode {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  const hex6 = /^#[0-9a-f]{6}$/i.test(value) ? value : "#000000";
  return (
    <div className="color-field">
      <input type="color" aria-label={`${label} picker`} value={hex6} onInput={(e) => onPreview?.((e.target as HTMLInputElement).value)} onChange={(e) => onChange(e.target.value)} />
      <input type="text" aria-label={label} value={text} spellCheck={false}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => { if (/^#[0-9a-f]{3,8}$/i.test(text)) onChange(text.toLowerCase()); else setText(value); }}
        onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }} />
    </div>
  );
}

export function SelectField<T extends string>({ value, options, onChange, label, disabled }: {
  value: T; options: ReadonlyArray<{ value: T; label: string }>; onChange: (v: T) => void; label: string; disabled?: boolean;
}): ReactNode {
  return (
    <select className="select" aria-label={label} disabled={disabled} value={value} onChange={(e) => onChange(e.target.value as T)}>
      {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  );
}

export function Tabs<T extends string>({ value, onChange, tabs, variant = "pill", label }: {
  value: T; onChange: (v: T) => void; tabs: ReadonlyArray<{ value: T; label: string }>; variant?: "pill" | "underline"; label: string;
}): ReactNode {
  const onKey = (e: React.KeyboardEvent): void => {
    const i = tabs.findIndex((t) => t.value === value);
    if (e.key === "ArrowRight") onChange((tabs[(i + 1) % tabs.length] as { value: T }).value);
    if (e.key === "ArrowLeft") onChange((tabs[(i - 1 + tabs.length) % tabs.length] as { value: T }).value);
  };
  return (
    <div role="tablist" aria-label={label} className={["tabs", variant === "underline" ? "tabs--underline" : ""].join(" ")} onKeyDown={onKey}>
      {tabs.map((t) => (
        <button key={t.value} type="button" role="tab" aria-selected={t.value === value} tabIndex={t.value === value ? 0 : -1} className="tabs__tab" onClick={() => onChange(t.value)}>
          {t.label}
        </button>
      ))}
    </div>
  );
}

const sectionState = new Map<string, boolean>();

export function Section({ sectionKey, title, collapsible = true, defaultOpen = true, children, actions }: {
  sectionKey: string; title: string; collapsible?: boolean; defaultOpen?: boolean; children: ReactNode; actions?: ReactNode;
}): ReactNode {
  const [open, setOpen] = useState(sectionState.get(sectionKey) ?? defaultOpen);
  const toggle = (): void => {
    sectionState.set(sectionKey, !open);
    setOpen(!open);
  };
  const isOpen = !collapsible || open;
  return (
    <section className={["section", isOpen ? "section--open" : "section--closed"].join(" ")}>
      <div className="section__header">
        {collapsible ? (
          <button type="button" className="section__toggle" aria-expanded={open} onClick={toggle}><span className="section__title">{title}</span></button>
        ) : <span className="section__title section__title--static">{title}</span>}
        {actions}
        {collapsible ? <button type="button" className="section__chevron-button" tabIndex={-1} aria-hidden="true" onClick={toggle}><Icon name="chevron-down" className="section__chevron" /></button> : null}
      </div>
      {isOpen ? <div className="section__content">{children}</div> : null}
    </section>
  );
}

export function Field({ label, children, action }: { label: string; children: ReactNode; action?: ReactNode }): ReactNode {
  return (
    <div className="field">
      <div className="field__label"><span className="label">{label}</span>{action}</div>
      {children}
    </div>
  );
}
