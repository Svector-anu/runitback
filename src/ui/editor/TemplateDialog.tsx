import { useMemo, useRef, useState, type ReactNode } from "react";
import "../styles/template-dialog.css";
import { useAssets, useEditorState } from "#/app/hooks";
import { getServices } from "#/app/services";
import { currentScene } from "#/engine/commands";
import type { MediaAssetInfo } from "#/engine/model";
import { applyTemplateToEditor, describeTemplate, templateFontFamilies, TemplateApplyError, type TemplateDescription, type TemplateWarning } from "#/engine/templates";
import { allElements } from "#/engine/timeline";
import { TICKS_PER_SECOND } from "#/engine/time";
import { loadFont } from "#/platform/fonts";
import { getTemplate, listTemplates, previewUrls } from "#/templates";
import { Button } from "../primitives/Button";
import { Dialog } from "../primitives/Dialog";
import { toast } from "../primitives/toast";
import { importAndReport } from "../assets/MediaView";
import {
  assetsForSlot, buildTemplateInputs, emptyRequiredSlots, fillUntouchedSlots, initialFillState, repeatTextPlaceholder,
  setRepeatCount, setRepeatItem, setSlot, setText, type FillState,
} from "../lib/template-fill";
import { categoryLabel, durationBadge, toCardData } from "../lib/template-gallery";

type Step = "choose" | "fill" | "done";
type SlotRow = TemplateDescription["slots"][number];

const CARDS = listTemplates().map(toCardData);

function assetLabel(asset: MediaAssetInfo): string {
  const seconds = asset.duration !== undefined ? ` (${durationBadge(Number(asset.duration) / TICKS_PER_SECOND)})` : "";
  return `${asset.name} - ${asset.type}${seconds}`;
}

function SlotPicker({ slot, value, assets, label, onChange }: {
  slot: SlotRow; value: string; assets: ReadonlyArray<MediaAssetInfo>; label: string; onChange: (assetId: string) => void;
}): ReactNode {
  const options = assetsForSlot(slot.kind, assets);
  const hint = [slot.optional ? "optional" : null, slot.expectedSeconds ? `about ${slot.expectedSeconds} s` : null, slot.hint ?? null].filter(Boolean).join(", ");
  return (
    <label className="tpl-field">
      <span className="tpl-field__label">{label}<em>{hint ? ` (${hint})` : ""}</em></span>
      <select className="select" value={value} onChange={(event) => onChange(event.target.value)} aria-label={label}>
        <option value="">{options.length === 0 ? `No ${slot.kind} imported yet` : "Leave empty"}</option>
        {options.map((asset) => <option key={asset.id} value={asset.id}>{assetLabel(asset)}</option>)}
      </select>
    </label>
  );
}

function TextInput({ id, label, value, placeholder, maxChars, onChange }: {
  id: string; label: string; value: string; placeholder?: string; maxChars?: number; onChange: (value: string) => void;
}): ReactNode {
  return (
    <label className="tpl-field" htmlFor={id}>
      <span className="tpl-field__label">{label}</span>
      <input id={id} className="input" type="text" value={value} placeholder={placeholder} maxLength={maxChars} onChange={(event) => onChange(event.target.value)} />
    </label>
  );
}

export function TemplateDialog({ open, onClose, initialTemplateId }: { open: boolean; onClose: () => void; initialTemplateId?: string }): ReactNode {
  const services = getServices();
  const assets = useAssets();
  const clipCount = useEditorState((state) => allElements(currentScene(state.doc).tracks).length);
  const [templateId, setTemplateId] = useState<string | null>(initialTemplateId && getTemplate(initialTemplateId) ? initialTemplateId : null);
  const [fill, setFill] = useState<FillState | null>(null);
  const [step, setStep] = useState<Step>(templateId ? "fill" : "choose");
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [warnings, setWarnings] = useState<TemplateWarning[]>([]);
  const fileInput = useRef<HTMLInputElement>(null);

  const template = templateId ? getTemplate(templateId) : undefined;
  const description = useMemo(() => (template ? describeTemplate(template) : null), [template]);
  const state = fill ?? (description ? initialFillState(description, assets) : null);

  const choose = (id: string): void => {
    const picked = getTemplate(id);
    if (!picked) return;
    setTemplateId(id);
    setFill(initialFillState(describeTemplate(picked), assets));
    setConfirming(false);
    setStep("fill");
  };

  const update = (change: (current: FillState) => FillState): void => {
    if (state) setFill(change(state));
  };

  const importMedia = async (files: FileList | null): Promise<void> => {
    if (!files || files.length === 0 || !description || !state) return;
    const imported = await importAndReport([...files]);
    if (imported.length > 0) setFill((current) => fillUntouchedSlots(description, current ?? state, [...assets, ...imported]));
  };

  const apply = async (replace: boolean): Promise<void> => {
    if (!template || !description || !state) return;
    setBusy(true);
    try {
      await Promise.all(templateFontFamilies(template).map((family) => loadFont(family)));
      const result = applyTemplateToEditor(services.editor, template, buildTemplateInputs(description, state), { replace });
      toast.success("Template applied. Undo to remove.");
      setConfirming(false);
      if (result.warnings.length > 0) {
        setWarnings(result.warnings);
        setStep("done");
      } else {
        onClose();
      }
    } catch (error) {
      if (error instanceof TemplateApplyError) toast.error(error.message, error.hint);
      else toast.error("Could not apply the template", error instanceof Error ? error.message : undefined);
    } finally {
      setBusy(false);
    }
  };

  const onApply = (): void => {
    if (clipCount > 0) setConfirming(true);
    else void apply(false);
  };

  const emptySlots = description && state ? emptyRequiredSlots(description, state) : [];
  const urls = template ? previewUrls(template) : null;

  let body: ReactNode;
  let footer: ReactNode;
  let title = "Templates";
  let subtitle: string | undefined = "Pick a starting point. It builds a whole video on the timeline from your clips, and one undo removes it.";

  if (step === "choose" || !description || !state) {
    body = (
      <ul className="tpl-cards">
        {CARDS.map((card) => (
          <li key={card.id}>
            <button type="button" className="tpl-card" onClick={() => choose(card.id)} aria-label={`${card.name}, ${card.aspect}, ${durationBadge(card.durationSeconds)}`}>
              <span className="tpl-card__media">{card.poster ? <img src={card.poster} alt="" loading="lazy" /> : null}<span className="tpl-card__badge">{durationBadge(card.durationSeconds)}</span></span>
              <span className="tpl-card__name">{card.name}</span>
              <span className="tpl-card__meta">{categoryLabel(card.category)} · {card.aspect}</span>
            </button>
          </li>
        ))}
      </ul>
    );
    footer = <Button variant="outline" onClick={onClose}>Close</Button>;
  } else if (step === "fill") {
    title = description.name;
    subtitle = description.description;
    body = (
      <div className="tpl-fill">
        {urls ? <img className="tpl-fill__poster" src={urls.poster} alt="" /> : null}
        <p className="tpl-facts">{description.aspect} · {durationBadge(description.durationSeconds)} · {description.fps} fps</p>
        {confirming ? (
          <p className="tpl-notice tpl-notice--warn" role="alert" data-testid="template-replace-confirm">
            This replaces the {clipCount} {clipCount === 1 ? "clip" : "clips"} on the timeline. Undo brings them back.
          </p>
        ) : null}

        <section className="tpl-section" aria-label="Your media">
          <div className="tpl-section__head">
            <h3>Your media</h3>
            <Button variant="outline" size="sm" onClick={() => fileInput.current?.click()}>Import media</Button>
            <input ref={fileInput} type="file" hidden multiple accept="video/*,image/*,audio/*" aria-label="Import media for the template"
              onChange={(event) => { const files = event.target.files; void importMedia(files).finally(() => { event.target.value = ""; }); }} />
          </div>
          {assets.length === 0 ? <p className="tpl-hint">No media in this project yet. Import clips here, or apply now and add them to the timeline later.</p> : null}
          {description.slots.map((slot) => (
            <SlotPicker key={slot.id} slot={slot} label={slot.label} value={state.slots[slot.id] ?? ""} assets={assets} onChange={(id) => update((s) => setSlot(s, slot.id, id))} />
          ))}
        </section>

        {description.texts.length > 0 ? (
          <section className="tpl-section" aria-label="Words">
            <h3>Words</h3>
            {description.texts.map((text) => (
              <TextInput key={text.id} id={`tpl-text-${text.id}`} label={text.label} value={state.texts[text.id] ?? ""} maxChars={text.maxChars} onChange={(value) => update((s) => setText(s, text.id, value))} />
            ))}
          </section>
        ) : null}

        {description.repeat.map((group) => {
          const groupFill = state.repeat[group.id];
          if (!groupFill) return null;
          return (
            <section key={group.id} className="tpl-section" aria-label={`${group.label} list`}>
              <div className="tpl-section__head">
                <h3>{group.label}s</h3>
                <label className="tpl-count">Number of {group.label.toLowerCase()}s
                  <select className="select" value={groupFill.count} onChange={(event) => update((s) => setRepeatCount(s, group, Number(event.target.value)))}>
                    {Array.from({ length: group.max - group.min + 1 }, (_, i) => group.min + i).map((n) => <option key={n} value={n}>{n}</option>)}
                  </select>
                </label>
              </div>
              {groupFill.items.slice(0, groupFill.count).map((item, index) => (
                <fieldset key={index} className="tpl-item">
                  <legend>{group.label} {index + 1}</legend>
                  {group.slots.map((slot) => (
                    <SlotPicker key={slot.id} slot={slot} label={`${group.label} ${index + 1}: ${slot.label}`} value={item.slots[slot.id] ?? ""} assets={assets}
                      onChange={(id) => update((s) => setRepeatItem(s, group.id, index, { slotId: slot.id, assetId: id }))} />
                  ))}
                  {group.texts.map((text) => (
                    <TextInput key={text.id} id={`tpl-${group.id}-${index}-${text.id}`} label={`${group.label} ${index + 1}: ${text.label}`} value={item.texts[text.id] ?? ""}
                      placeholder={repeatTextPlaceholder(text.default, index, groupFill.count)} maxChars={text.maxChars}
                      onChange={(value) => update((s) => setRepeatItem(s, group.id, index, { textId: text.id, value }))} />
                  ))}
                </fieldset>
              ))}
            </section>
          );
        })}

        {emptySlots.length > 0 ? <p className="tpl-hint" data-testid="template-empty-slots">Empty for now: {emptySlots.join(", ")}. Those parts stay blank until you add media.</p> : null}
      </div>
    );
    footer = confirming ? (
      <>
        <Button variant="outline" disabled={busy} onClick={() => setConfirming(false)}>Cancel</Button>
        <Button variant="destructive" disabled={busy} onClick={() => void apply(true)}>Replace and apply</Button>
      </>
    ) : (
      <>
        <Button variant="outline" disabled={busy} onClick={() => { setStep("choose"); setConfirming(false); }}>All templates</Button>
        <Button disabled={busy} onClick={onApply}>{busy ? "Applying..." : "Apply template"}</Button>
      </>
    );
  } else {
    title = "Template applied";
    subtitle = "Undo removes it in one step. A few things to know:";
    body = (
      <ul className="tpl-warnings" data-testid="template-warnings">
        {warnings.map((warning, index) => <li key={`${warning.code}-${index}`}>{warning.message}</li>)}
      </ul>
    );
    footer = <Button onClick={onClose}>Done</Button>;
  }

  return (
    <Dialog open={open} onClose={onClose} title={title} description={subtitle} wide footer={footer}>
      {body}
    </Dialog>
  );
}
