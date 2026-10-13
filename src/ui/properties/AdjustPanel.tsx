import { useRef, useState, type CSSProperties, type ReactNode } from "react";
import { currentScene } from "#/engine/commands";
import type { ElementRef, FilterPresetId, ParamValues, TimelineElement } from "#/engine/model";
import { allElements } from "#/engine/timeline";
import { getServices } from "#/app/services";
import { Icon } from "../icons";
import { Button } from "../primitives/Button";
import { Field, Section } from "../primitives/fields";
import { SliderField } from "../primitives/SliderField";
import { runEdit } from "../lib/edit";
import {
  ADJUST_DEFS, FILTER_LABELS, FILTER_PRESET_IDS, NEUTRAL_ADJUST, adjustCommand, adjustEffectOf, clearAdjustCommand, matchPreset, scaledPreset, swatchLook,
} from "./adjust-logic";

const SAMPLE_PICTURE = "linear-gradient(180deg, #5b8fd6 0%, #9cc3ea 38%, #e9c27b 52%, #6f8f4e 70%, #3d5a33 100%)";

function Swatch({ label, params, thumbnail, pressed, onSelect }: {
  label: string; params: ParamValues; thumbnail: string | undefined; pressed: boolean; onSelect: () => void;
}): ReactNode {
  const look = swatchLook(params);
  const picture = thumbnail ? `url(${JSON.stringify(thumbnail)})` : SAMPLE_PICTURE;
  const layers: CSSProperties[] = [
    { backgroundImage: picture, filter: look.filter },
    { backgroundImage: look.cast },
    { backgroundImage: look.vignette },
  ];
  return (
    <button type="button" className="filter-swatch" aria-pressed={pressed} aria-label={`${label} filter`} title={`${label} filter`} onClick={onSelect}>
      <span className="filter-swatch__picture" aria-hidden="true">
        {layers.map((style, i) => <span key={i} className="filter-swatch__layer" style={style} />)}
      </span>
      <span className="filter-swatch__label">{label}</span>
    </button>
  );
}

/** Filter picker, intensity and the eight colour sliders. Every gesture is `editor.preview` then one committed command. */
export function AdjustPanel({ element, refValue, thumbnail }: { element: TimelineElement; refValue: ElementRef; thumbnail: string | undefined }): ReactNode {
  const { editor } = getServices();
  const pendingEffectId = useRef<string | null>(null);
  const [chosen, setChosen] = useState<{ elementId: string; id: FilterPresetId } | null>(null);

  const existing = adjustEffectOf(element);
  const params = existing?.params ?? NEUTRAL_ADJUST;
  const match = matchPreset(params);
  const stickyId = chosen?.elementId === element.id ? chosen.id : null;
  const activeId = match.kind === "preset" ? match.id : match.kind === "none" && existing ? stickyId : null;
  const intensity = match.kind === "preset" ? match.intensity : activeId ? 0 : 1;

  /** The command is always built from the committed clip, so a preview's own effect never makes the commit skip creating it. */
  const build = (values: ParamValues, reset: boolean, label: string): ReturnType<typeof adjustCommand> => {
    const committed = allElements(currentScene(editor.getState().doc).tracks).find((l) => l.element.id === element.id)?.element ?? element;
    pendingEffectId.current ??= editor.newId();
    return adjustCommand({ element: committed, ref: refValue, values, reset, effectId: pendingEffectId.current, label });
  };
  const preview = (values: ParamValues, reset: boolean, label: string): void => { editor.preview(build(values, reset, label)); };
  const commit = (values: ParamValues, reset: boolean, label: string): void => {
    if (runEdit(editor, build(values, reset, label))) pendingEffectId.current = null;
  };

  const choose = (id: FilterPresetId | "none"): void => {
    if (id === "none") {
      setChosen(null);
      const clear = clearAdjustCommand({ element: allElements(currentScene(editor.getState().doc).tracks).find((l) => l.element.id === element.id)?.element ?? element, ref: refValue });
      if (clear) runEdit(editor, clear);
      return;
    }
    setChosen({ elementId: element.id, id });
    commit(scaledPreset(id, 1), true, `Filter: ${FILTER_LABELS[id]}`);
  };

  return (
    <>
      <Section sectionKey={`${element.id}:filters`} title="Filters" collapsible>
        <div className="section__fields">
          <div className="filter-grid" role="group" aria-label="Filter presets">
            {FILTER_PRESET_IDS.map((id) => (
              <Swatch key={id} label={FILTER_LABELS[id]} params={scaledPreset(id, 1)} thumbnail={thumbnail} pressed={activeId === id} onSelect={() => choose(id)} />
            ))}
            <Swatch label="None" params={NEUTRAL_ADJUST} thumbnail={thumbnail} pressed={activeId === null && match.kind === "none"} onSelect={() => choose("none")} />
          </div>
          <Field label="Intensity">
            <SliderField
              label="Filter intensity" value={intensity} min={0} max={1} step={0.01} defaultValue={1} displayMultiplier={100} suffix="%" disabled={activeId === null}
              onPreview={(v) => activeId && preview(scaledPreset(activeId, v), true, "Filter intensity")}
              onCommit={(v) => activeId && commit(scaledPreset(activeId, v), true, "Filter intensity")}
            />
          </Field>
          {match.kind === "custom" ? <p className="muted">Custom look: the sliders below moved away from the preset.</p> : null}
        </div>
      </Section>
      <Section
        sectionKey={`${element.id}:adjust`} title="Adjust" collapsible
        actions={
          <span className="adjust-actions" onClick={(e) => e.stopPropagation()}>
            <Button variant="ghost" size="icon" label="Reset all adjustments" disabled={!existing} onClick={() => choose("none")}><Icon name="reset" /></Button>
          </span>
        }
      >
        <div className="section__fields">
          {ADJUST_DEFS.map((def) => def.type !== "number" ? null : (
            <Field key={def.key} label={def.label}>
              <SliderField
                label={def.label} value={Number(params[def.key] ?? def.default)} min={def.min ?? 0} max={def.max ?? 100} step={def.step} defaultValue={def.default}
                onPreview={(v) => preview({ [def.key]: v }, false, `Adjust ${def.label.toLowerCase()}`)}
                onCommit={(v) => commit({ [def.key]: v }, false, `Adjust ${def.label.toLowerCase()}`)}
              />
            </Field>
          ))}
        </div>
      </Section>
    </>
  );
}
