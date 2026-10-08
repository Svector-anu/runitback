import { useEffect, useState, type ReactNode } from "react";
import { removeKeyframeCommand, upsertKeyframeCommand } from "#/engine/commands";
import { keyframeIdAtTime } from "#/engine/animation";
import { SYSTEM_FONTS_LIST } from "./fonts";
import type { ElementRef, ParamValue, TimelineElement } from "#/engine/model";
import { allElements, resolvePathValue } from "#/engine/timeline";
import { currentScene } from "#/engine/commands";
import { getServices } from "#/app/services";
import { animationPathFor, paramEditCommand } from "#/app/param-edit";
import { loadFont } from "#/platform/fonts";
import { Icon } from "../icons";
import { Button } from "../primitives/Button";
import { ColorField, Field, NumberField, SelectField, Switch } from "../primitives/fields";
import type { FieldDef } from "./defs";

/** Value at the playhead for a field, honouring keyframes. */
export function fieldValue(element: TimelineElement, def: FieldDef, playhead: number): ParamValue {
  const path = animationPathFor(element, def.key);
  const local = Math.max(0, Math.min(element.duration, playhead - element.startTime));
  return resolvePathValue(element, path, local) ?? (def.default as ParamValue);
}

function KeyframeToggle({ element, refValue, def, playhead }: { element: TimelineElement; refValue: ElementRef; def: FieldDef; playhead: number }): ReactNode {
  const { editor } = getServices();
  const path = animationPathFor(element, def.key);
  const local = playhead - element.startTime;
  const inRange = local >= 0 && local <= element.duration;
  const id = keyframeIdAtTime(element.animations, path, Math.round(local));
  const toggle = (): void => {
    if (id) {
      editor.execute(removeKeyframeCommand({ ref: refValue, path, keyframeId: id, localTime: Math.round(local) }));
    } else {
      editor.execute(upsertKeyframeCommand({ ref: refValue, path, time: Math.round(local), value: fieldValue(element, def, playhead) }));
    }
  };
  return (
    <button type="button" className="btn btn--text" disabled={!inRange} aria-pressed={!!id}
      aria-label={id ? `Remove ${def.label} keyframe` : `Add ${def.label} keyframe`}
      title={inRange ? (id ? "Remove keyframe" : "Add keyframe") : "Move the playhead inside the clip to keyframe"}
      style={{ color: id ? "var(--primary)" : "var(--muted-foreground)", opacity: inRange ? 1 : 0.4 }} onClick={toggle}>
      <Icon name="keyframe" size={14} style={id ? { fill: "var(--primary)" } : undefined} />
    </button>
  );
}

export function ParamControl({ element, refValue, def, playhead }: { element: TimelineElement; refValue: ElementRef; def: FieldDef; playhead: number }): ReactNode {
  const { editor } = getServices();
  const value = fieldValue(element, def, playhead);
  const committedElement = allElements(currentScene(editor.getState().doc).tracks).find((l) => l.element.id === element.id)?.element ?? element;
  const committedValue = fieldValue(committedElement, def, playhead);
  const [fontText, setFontText] = useState(String(value));
  useEffect(() => setFontText(String(value)), [value]);

  const apply = (next: ParamValue, mode: "preview" | "commit"): void => {
    const cmd = paramEditCommand({ element, ref: refValue, values: { [def.key]: next }, playhead, label: `Edit ${def.label.toLowerCase()}` });
    if (mode === "preview") editor.preview(cmd);
    else editor.execute(cmd);
  };

  const toggle = def.keyframable ? <KeyframeToggle element={element} refValue={refValue} def={def} playhead={playhead} /> : undefined;
  const label = def.label;
  let control: ReactNode;
  switch (def.type) {
    case "number":
      control = (
        <NumberField label={label} value={Number(value)} defaultValue={def.default} min={def.min} max={def.max} step={def.step}
          displayMultiplier={def.displayMultiplier} suffix={def.suffix} icon={def.icon} scrub={def.icon ? { pxPerUnit: 1 / Math.max(def.step, 0.01) } : undefined}
          onPreview={(v) => apply(v, "preview")} onCommit={(v) => apply(v, "commit")} onCancel={() => editor.discardPreview()} />
      );
      break;
    case "boolean":
      control = <Switch label={label} checked={value === true} onChange={(v) => apply(v, "commit")} />;
      break;
    case "color":
      control = <ColorField label={label} value={String(value)} onPreview={(v) => apply(v, "preview")} onChange={(v) => apply(v, "commit")} />;
      break;
    case "select":
      control = <SelectField label={label} value={String(value)} options={def.options} onChange={(v) => apply(v, "commit")} />;
      break;
    case "text":
      control = def.widget === "textarea" ? (
        <textarea className="textarea" aria-label={label} defaultValue={String(committedValue)} key={String(committedValue)} rows={3}
          onChange={(e) => apply(e.target.value, "preview")} onBlur={(e) => { if (e.target.value !== String(committedValue)) apply(e.target.value, "commit"); else editor.discardPreview(); }} />
      ) : (
        <>
          <input className="input" list="font-families" aria-label={label} value={fontText} onChange={(e) => setFontText(e.target.value)}
            onBlur={() => { const family = fontText.trim(); if (family && family !== value) { void loadFont(family).then(() => apply(family, "commit")); } else setFontText(String(value)); }}
            onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }} />
          <datalist id="font-families">{SYSTEM_FONTS_LIST.map((f) => <option key={f} value={f} />)}</datalist>
        </>
      );
      break;
  }
  if (def.type === "boolean") {
    return (
      <div className="field" style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
        <span className="label">{label}</span>{control}
      </div>
    );
  }
  return <Field label={label} action={toggle}>{control}</Field>;
}

export function SimpleButton({ onClick, children }: { onClick: () => void; children: ReactNode }): ReactNode {
  return <Button size="sm" onClick={onClick}>{children}</Button>;
}
