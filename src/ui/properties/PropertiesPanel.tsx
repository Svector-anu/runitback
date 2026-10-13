import { useState, type ReactNode } from "react";
import {
  addClipEffect, addMask, removeClipEffect, removeMask, reorderClipEffects, toggleClipEffect, toggleMaskInverted,
  updateClipEffectParams, updateElements, updateMaskParams,
} from "#/engine/commands";
import {
  GRAPHIC_DEFINITIONS, MASK_DEFINITIONS, EFFECT_DEFINITIONS, RETIME_MAX, RETIME_MIN, coerceParam, getEffectDefinition, isMaskable,
  type Effect, type ElementRef, type Mask, type MaskType, type ParamDef, type ParamValues, type TimelineElement,
} from "#/engine/model";
import { getElement } from "#/engine/timeline";
import { getServices } from "#/app/services";
import { useAssets, useEditorState, usePlaybackState, useTracks } from "#/app/hooks";
import { uiStore } from "#/app/ui-state";
import { colorPickStore } from "#/app/color-pick";
import { Icon, type IconName } from "../icons";
import { Button } from "../primitives/Button";
import { DropdownMenu } from "../primitives/Menu";
import { ColorField, Field, NumberField, Section, SelectField, Switch } from "../primitives/fields";
import { AUDIO_FIELDS, BLEND_FIELDS, CROP_FIELDS, MASK_LABELS, SHADOW_FIELDS, STROKE_FIELDS, TEXT_FIELDS, TRANSFORM_FIELDS, type FieldDef } from "./defs";
import { AdjustPanel } from "./AdjustPanel";
import { TextAnimationControls } from "./TextAnimationControls";
import { ParamControl } from "./ParamControl";
import { SpeedCurveEditor } from "./SpeedCurveEditor";
import { MotionTab } from "./MotionTab";
import { BackgroundRemovalStatus } from "./BackgroundRemovalStatus";
import { startBackgroundAnalysis } from "#/app/background-removal";
import { runEdit } from "../lib/edit";

type TabId = "text" | "style" | "adjust" | "transform" | "blending" | "audio" | "speed" | "masks" | "effects" | "graphic" | "motion";

const TAB_META: Record<TabId, { label: string; icon: IconName }> = {
  text: { label: "Text", icon: "type" }, style: { label: "Style", icon: "star" }, adjust: { label: "Adjust", icon: "sliders" }, transform: { label: "Transform", icon: "move" }, blending: { label: "Blending", icon: "droplet" },
  audio: { label: "Audio", icon: "music" }, speed: { label: "Speed", icon: "gauge" }, masks: { label: "Masks", icon: "shapes" },
  effects: { label: "Effects", icon: "wand" }, graphic: { label: "Graphic", icon: "shapes" }, motion: { label: "Motion", icon: "crosshair" },
};

const TABS_BY_TYPE: Record<TimelineElement["type"], TabId[]> = {
  text: ["text", "style", "transform", "blending", "effects", "motion"],
  video: ["transform", "adjust", "audio", "speed", "blending", "masks", "effects", "motion"],
  image: ["transform", "adjust", "blending", "masks", "effects", "motion"],
  graphic: ["graphic", "transform", "blending", "masks", "effects", "motion"],
  audio: ["audio", "speed"],
  effect: ["effects"],
};

function toFieldDef(def: ParamDef, keyframable: boolean): FieldDef {
  return { ...def, keyframable: keyframable && def.type !== "select" && def.type !== "boolean" };
}

function Fields({ element, refValue, defs, playhead }: { element: TimelineElement; refValue: ElementRef; defs: FieldDef[]; playhead: number }): ReactNode {
  return (
    <div className="section__fields">
      {defs.filter((d) => !d.showWhen || d.showWhen(element.params)).map((def) => (
        <ParamControl key={def.key} element={element} refValue={refValue} def={def} playhead={playhead} />
      ))}
    </div>
  );
}

/** Generic param editor for values stored outside element.params (effects, masks). */
function ParamFields({ defs, values, onPreview, onCommit, colorPicker }: {
  defs: ReadonlyArray<ParamDef>; values: ParamValues; onPreview?: (v: ParamValues) => void; onCommit: (v: ParamValues) => void;
  /** Adds an eyedropper button to colour parameters: starts a pick from the preview. */
  colorPicker?: { active: boolean; onStart: () => void };
}): ReactNode {
  return (
    <div className="section__fields">
      {defs.map((def) => {
        const value = values[def.key] ?? def.default;
        const commit = (v: unknown): void => {
          const coerced = coerceParam(def, v);
          if (coerced !== null) onCommit({ [def.key]: coerced });
        };
        switch (def.type) {
          case "number":
            return (
              <Field key={def.key} label={def.label}>
                <NumberField label={def.label} value={Number(value)} defaultValue={def.default} min={def.min} max={def.max} step={def.step}
                  onPreview={onPreview ? (v) => onPreview({ [def.key]: v }) : undefined} onCommit={commit} />
              </Field>
            );
          case "boolean":
            return (
              <div key={def.key} className="field" style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
                <span className="label">{def.label}</span><Switch label={def.label} checked={value === true} onChange={commit} />
              </div>
            );
          case "color":
            return (
              <Field key={def.key} label={def.label}>
                <ColorField label={def.label} value={String(value)} onChange={commit} />
                {colorPicker ? (
                  <Button size="sm" variant={colorPicker.active ? "secondary" : "ghost"} aria-pressed={colorPicker.active} onClick={colorPicker.onStart}>
                    <Icon name="pipette" />{colorPicker.active ? "Click the preview (Esc cancels)" : "Pick from preview"}
                  </Button>
                ) : null}
              </Field>
            );
          case "select":
            return <Field key={def.key} label={def.label}><SelectField label={def.label} value={String(value)} options={def.options} onChange={commit} /></Field>;
        }
      })}
    </div>
  );
}

function SpeedTab({ element, refValue }: { element: TimelineElement; refValue: ElementRef }): ReactNode {
  return (
    <>
      <ConstantSpeedSection element={element} refValue={refValue} />
      {element.type === "video" || element.type === "audio" ? <SpeedCurveEditor element={element} refValue={refValue} /> : null}
    </>
  );
}

function ConstantSpeedSection({ element, refValue }: { element: TimelineElement; refValue: ElementRef }): ReactNode {
  const { editor } = getServices();
  const retime = "retime" in element ? element.retime : undefined;
  const rate = retime?.rate ?? 1;
  const maintainPitch = retime?.maintainPitch === true;
  const apply = (next: number, mode: "preview" | "commit"): void => {
    const nextRetime = next === 1 ? undefined : { rate: next, ...(maintainPitch ? { maintainPitch } : {}) };
    const cmd = updateElements([{ ref: refValue, patch: { retime: nextRetime } }], "Change speed");
    if (mode === "preview") editor.preview(cmd);
    else runEdit(editor, cmd);
  };
  const setChangePitch = (changePitch: boolean): void => {
    runEdit(editor, updateElements([{ ref: refValue, patch: { retime: { rate, maintainPitch: !changePitch } } }], "Change pitch handling"));
  };
  return (
    <Section sectionKey={`${element.id}:speed`} title="Speed" collapsible>
      <div className="section__fields">
        <Field label={retime?.curve ? "Average speed" : "Speed"}>
          <NumberField label="Speed" value={rate} defaultValue={1} min={RETIME_MIN} max={RETIME_MAX} step={0.01} suffix="x" icon="gauge"
            scrub={{ pxPerUnit: 48, ranges: [{ upTo: 1, pxPerUnit: 160 }] }}
            onPreview={(v) => apply(v, "preview")} onCommit={(v) => apply(v, "commit")} onCancel={() => editor.discardPreview()} />
        </Field>
        <div className="row-between">
          <span className="label">Change pitch</span>
          <Switch label="Change pitch" checked={!maintainPitch} disabled={rate === 1} onChange={setChangePitch} />
        </div>
        <p className="muted">Off keeps the original pitch when speed changes. Only applies when speed is not 1x.</p>
        <p className="muted">Changing speed changes the clip&apos;s length on the timeline; trims stay in source time.</p>
      </div>
    </Section>
  );
}

function MasksTab({ element, refValue }: { element: TimelineElement; refValue: ElementRef }): ReactNode {
  const { editor } = getServices();
  const masks: Mask[] = (element as { masks?: Mask[] }).masks ?? [];
  const types = Object.keys(MASK_DEFINITIONS) as MaskType[];
  return (
    <>
      <div className="row-between">
        <span style={{ fontWeight: 500 }}>Masks</span>
        <DropdownMenu align="end" width={160}
          entries={types.map((t) => ({ label: MASK_LABELS[t] ?? t, onSelect: () => runEdit(editor, addMask(refValue, t)) }))}
          trigger={(p) => <Button {...p} variant="ghost" size="icon" label="Add mask"><Icon name="plus" /></Button>} />
      </div>
      {masks.length === 0 ? (
        <div className="empty" style={{ height: "auto", padding: 32 }}><Icon name="shapes" /><h3>No masks</h3><p>Add a mask to reveal only part of this layer. Only the first mask is rendered.</p></div>
      ) : null}
      {masks.map((mask, i) => {
        const def = MASK_DEFINITIONS[mask.type];
        return (
          <Section key={mask.id} sectionKey={`${element.id}:mask:${mask.id}`} title={`${MASK_LABELS[mask.type] ?? mask.type}${i > 0 ? " (inactive)" : ""}`}
            actions={
              <span style={{ display: "flex", gap: 4, marginLeft: "auto" }} onClick={(e) => e.stopPropagation()}>
                <Button variant={mask.params.inverted === true ? "secondary" : "ghost"} size="icon" label="Invert mask" aria-pressed={mask.params.inverted === true}
                  onClick={() => runEdit(editor, toggleMaskInverted(refValue, mask.id))}><Icon name="droplet" /></Button>
                <Button variant="ghost" size="icon" label="Remove mask" onClick={() => runEdit(editor, removeMask(refValue, mask.id))}><Icon name="trash" /></Button>
              </span>
            }>
            <ParamFields defs={def.params.filter((p) => p.key !== "inverted")} values={mask.params}
              onPreview={(v) => editor.preview(updateMaskParams(refValue, mask.id, v))} onCommit={(v) => runEdit(editor, updateMaskParams(refValue, mask.id, v))} />
          </Section>
        );
      })}
    </>
  );
}

function EffectsTab({ element, refValue }: { element: TimelineElement; refValue: ElementRef }): ReactNode {
  const { editor } = getServices();
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [overIndex, setOverIndex] = useState<number | null>(null);
  const pickTarget = colorPickStore.use((s) => s.target);

  if (element.type === "effect") {
    const def = getEffectDefinition(element.effectType);
    return def ? (
      <Section sectionKey={`${element.id}:effect`} title={def.name} collapsible={false}>
        <ParamFields defs={def.params} values={element.params}
          onPreview={(v) => editor.preview(updateElements([{ ref: refValue, patch: { params: v } }]))}
          onCommit={(v) => runEdit(editor, updateElements([{ ref: refValue, patch: { params: v } }], "Edit effect"))} />
      </Section>
    ) : null;
  }
  const effects: Effect[] = (element as { effects?: Effect[] }).effects ?? [];
  return (
    <>
      <div className="row-between">
        <span style={{ fontWeight: 500 }}>Effects</span>
        <DropdownMenu align="end" width={160}
          entries={Object.values(EFFECT_DEFINITIONS).map((d) => ({ label: d.name, onSelect: () => {
            if (runEdit(editor, addClipEffect({ ref: refValue, effectType: d.type })) && d.type === "remove-background" && "mediaId" in element) startBackgroundAnalysis(element.mediaId);
          } }))}
          trigger={(p) => <Button {...p} variant="ghost" size="icon" label="Add effect"><Icon name="plus" /></Button>} />
      </div>
      {effects.length === 0 ? (
        <div className="empty" style={{ height: "auto", padding: 32 }}>
          <Icon name="wand" /><h3>No effects</h3><p>Add effects to this layer from the Assets panel.</p>
          <Button size="sm" onClick={() => uiStore.set({ assetTab: "effects" })}>Open effects</Button>
        </div>
      ) : null}
      {effects.map((effect, i) => {
        const def = getEffectDefinition(effect.type);
        if (!def) return null;
        const show = dragIndex !== null && overIndex === i && dragIndex !== i ? (dragIndex < i ? "after" : "before") : undefined;
        return (
          <div key={effect.id} className="effect-card" data-disabled={!effect.enabled} data-dragging={dragIndex === i} data-drop={show}
            draggable onDragStart={() => setDragIndex(i)} onDragOver={(e) => { e.preventDefault(); setOverIndex(i); }}
            onDragEnd={() => { setDragIndex(null); setOverIndex(null); }}
            onDrop={() => { if (dragIndex !== null && dragIndex !== i) runEdit(editor, reorderClipEffects(refValue, dragIndex, i)); setDragIndex(null); setOverIndex(null); }}>
            <Section sectionKey={`${element.id}:fx:${effect.id}`} title={def.name}
              actions={
                <span style={{ display: "flex", gap: 4, marginLeft: "auto" }} onClick={(e) => e.stopPropagation()}>
                  <Button variant={effect.enabled ? "secondary" : "ghost"} size="icon" label={effect.enabled ? "Disable effect" : "Enable effect"} aria-pressed={effect.enabled}
                    onClick={() => runEdit(editor, toggleClipEffect(refValue, effect.id))}><Icon name={effect.enabled ? "eye" : "eye-off"} /></Button>
                  <Button variant="ghost" size="icon" label="Remove effect" onClick={() => runEdit(editor, removeClipEffect(refValue, effect.id))}><Icon name="trash" /></Button>
                </span>
              }>
              {effect.type === "remove-background" ? <BackgroundRemovalStatus element={element} /> : null}
              <ParamFields defs={def.params} values={effect.params}
                colorPicker={effect.type === "chroma-key" ? { active: pickTarget?.effectId === effect.id, onStart: () => colorPickStore.set({ target: pickTarget?.effectId === effect.id ? null : { ref: refValue, effectId: effect.id } }) } : undefined}
                onPreview={(v) => editor.preview(updateClipEffectParams(refValue, effect.id, v))}
                onCommit={(v) => runEdit(editor, updateClipEffectParams(refValue, effect.id, v))} />
            </Section>
          </div>
        );
      })}
    </>
  );
}

export function PropertiesPanel(): ReactNode {
  const selection = useEditorState((s) => s.selection.elements);
  const tracks = useTracks();
  const assets = useAssets();
  const playhead = usePlaybackState((s) => s.currentTime);
  const tabs = uiStore.use((s) => s.propertyTabs);

  if (selection.length === 0) {
    return (
      <div className="panel panel-box" style={{ width: "100%" }}>
        <div className="empty"><Icon name="sliders" /><h3>It&apos;s empty here</h3><p>Click an element on the timeline to edit its properties</p></div>
      </div>
    );
  }
  if (selection.length > 1) {
    return (
      <div className="panel panel-box" style={{ width: "100%" }}>
        <div className="empty"><p>{selection.length} elements selected</p></div>
      </div>
    );
  }
  const ref = selection[0] as ElementRef;
  const element = getElement(tracks, ref);
  if (!element) return <div className="panel panel-box" style={{ width: "100%" }} />;

  const asset = "mediaId" in element ? assets.find((a) => a.id === element.mediaId) : undefined;
  const available = TABS_BY_TYPE[element.type].filter((t) => !(t === "audio" && element.type === "video" && asset?.hasAudio === false));
  const remembered = tabs[element.type] as TabId | undefined;
  const active: TabId = remembered && available.includes(remembered) ? remembered : (available[0] as TabId);
  const setActive = (tab: TabId): void => uiStore.set({ propertyTabs: { ...uiStore.get().propertyTabs, [element.type]: tab } });
  const key = (suffix: string): string => `${element.id}:${suffix}`;

  let content: ReactNode;
  switch (active) {
    case "text": content = <Section sectionKey={key("text")} title="Text" collapsible={false}><Fields element={element} refValue={ref} defs={TEXT_FIELDS} playhead={playhead} /></Section>; break;
    case "style":
      content = element.type === "text" ? (
        <>
          <Section sectionKey={key("stroke")} title="Stroke"><Fields element={element} refValue={ref} defs={STROKE_FIELDS} playhead={playhead} /></Section>
          <Section sectionKey={key("shadow")} title="Shadow"><Fields element={element} refValue={ref} defs={SHADOW_FIELDS} playhead={playhead} /></Section>
          <Section sectionKey={key("animation")} title="Animation"><TextAnimationControls element={element} refValue={ref} /></Section>
        </>
      ) : null;
      break;
    case "adjust": content = <AdjustPanel element={element} refValue={ref} thumbnail={asset?.thumbnail} />; break;
    case "transform":
      content = (
        <>
          <Section sectionKey={key("transform")} title="Transform" collapsible={false}><Fields element={element} refValue={ref} defs={TRANSFORM_FIELDS} playhead={playhead} /></Section>
          {element.type === "video" || element.type === "image" ? (
            <Section sectionKey={key("crop")} title="Crop"><Fields element={element} refValue={ref} defs={CROP_FIELDS} playhead={playhead} /></Section>
          ) : null}
        </>
      );
      break;
    case "blending": content = <Section sectionKey={key("blending")} title="Blending" collapsible={false}><Fields element={element} refValue={ref} defs={BLEND_FIELDS} playhead={playhead} /></Section>; break;
    case "audio": content = <Section sectionKey={key("audio")} title="Audio" collapsible={false}><Fields element={element} refValue={ref} defs={AUDIO_FIELDS} playhead={playhead} /></Section>; break;
    case "speed": content = <SpeedTab element={element} refValue={ref} />; break;
    case "masks": content = isMaskable(element) ? <MasksTab element={element} refValue={ref} /> : null; break;
    case "effects": content = <EffectsTab element={element} refValue={ref} />; break;
    case "motion": content = <MotionTab element={element} refValue={ref} />; break;
    case "graphic": {
      const def = element.type === "graphic" ? GRAPHIC_DEFINITIONS[element.definitionId] : undefined;
      content = def ? <Section sectionKey={key("graphic")} title={def.name} collapsible={false}><Fields element={element} refValue={ref} defs={def.params.map((p) => toFieldDef(p, true))} playhead={playhead} /></Section> : null;
      break;
    }
  }

  return (
    <div className="panel panel-box properties" style={{ width: "100%" }}>
      <div className="properties__rail" role="tablist" aria-label="Property tabs" aria-orientation="vertical">
        {available.map((tab) => (
          <Button key={tab} role="tab" aria-selected={tab === active} variant={tab === active ? "secondary" : "ghost"} size="icon-lg" label={TAB_META[tab].label}
            title={TAB_META[tab].label} className={tab === active ? "" : "btn--muted"} onClick={() => setActive(tab)}>
            <Icon name={TAB_META[tab].icon} />
          </Button>
        ))}
      </div>
      <div className="properties__content scrollbar-hidden" role="tabpanel" aria-label={TAB_META[active].label}>{content}</div>
    </div>
  );
}

