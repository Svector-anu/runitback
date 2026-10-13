import { useRef, useState, type ReactNode } from "react";
import { insertElementsOnLanes } from "#/engine/commands";
import { parseSubtitleFile } from "#/engine/captions";
import { EFFECT_DEFINITIONS, GRAPHIC_DEFINITIONS, type GraphicDefinition } from "#/engine/model";
import { getServices } from "#/app/services";
import { insertPayload } from "#/app/insert";
import { buildCaptionElement } from "#/render/caption-elements";
import { canvasLineMeasurer } from "#/render/text";
import { context2d, createCanvas } from "#/render/canvas";
import { beginDrag, endDrag, type DragPayload } from "../dnd";
import { Icon, type IconName } from "../icons";
import { Button } from "../primitives/Button";
import { toast } from "../primitives/toast";
import { reportInsert, runEdit } from "../lib/edit";
import { TextToSpeechPanel } from "./TextToSpeechPanel";
import { TranslateCaptions } from "./TranslateCaptions";

function ViewShell({ title, actions, children }: { title: string; actions?: ReactNode; children: ReactNode }): ReactNode {
  return (
    <div className="assets__view">
      <div className="view__header"><span className="view__title">{title}</span><div className="view__actions">{actions}</div></div>
      <div className="view__body scrollbar-hidden">{children}</div>
    </div>
  );
}

function PayloadTile({ payload, label, children }: { payload: DragPayload; label: string; children: ReactNode }): ReactNode {
  const { editor } = getServices();
  const add = (): void => {
    reportInsert(insertPayload({ editor, payload, startTime: editor.playback.getState().currentTime }));
  };
  return (
    <div className="tile" draggable role="button" tabIndex={0} aria-label={`Add ${label}`}
      onDragStart={(e) => beginDrag(e, payload)} onDragEnd={endDrag} onDoubleClick={add}
      onKeyDown={(e) => { if (e.key === "Enter") add(); }}>
      <div className="tile__box">
        {children}
        <button type="button" className="media-item__add" aria-label={`Add ${label} to timeline`} onClick={add}><Icon name="plus" /></button>
      </div>
      <div className="tile__label">{label}</div>
    </div>
  );
}

export function TextView(): ReactNode {
  return (
    <ViewShell title="Text">
      <div className="tile-grid">
        <PayloadTile payload={{ kind: "text" }} label="Default text"><span style={{ fontSize: "var(--text-xs)" }}>Default text</span></PayloadTile>
      </div>
      <TextToSpeechPanel />
    </ViewShell>
  );
}

const SHAPE_ICON: Record<string, IconName> = { rectangle: "square", ellipse: "circle", polygon: "polygon", star: "star", cursor: "pointer", "window-frame": "app-window" };

export function GraphicsView(): ReactNode {
  return (
    <ViewShell title="Graphics">
      <div className="tile-grid">
        {Object.values(GRAPHIC_DEFINITIONS).map((def: GraphicDefinition) => (
          <PayloadTile key={def.id} payload={{ kind: "graphic", definitionId: def.id }} label={def.name}>
            <Icon name={SHAPE_ICON[def.id] ?? "shapes"} size={40} />
          </PayloadTile>
        ))}
      </div>
    </ViewShell>
  );
}

export function EffectsView(): ReactNode {
  return (
    <ViewShell title="Effects">
      <div className="tile-grid">
        {Object.values(EFFECT_DEFINITIONS).map((def) => (
          <PayloadTile key={def.type} payload={{ kind: "effect", effectType: def.type }} label={def.name}>
            <div style={{ width: "100%", height: "100%", background: "conic-gradient(from 45deg, #2567ec, #37b6f7, #ba5d7a, #5dbaa0, #2567ec)", filter: "blur(6px)" }} />
          </PayloadTile>
        ))}
      </div>
      <p className="muted" style={{ marginTop: 12, lineHeight: 1.5 }}>Drag onto a clip to apply it to that clip, or onto an empty area to add an effect layer that blurs everything beneath it.</p>
    </ViewShell>
  );
}

export function CaptionsView(): ReactNode {
  const { editor } = getServices();
  const input = useRef<HTMLInputElement>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  const importFile = async (file: File): Promise<void> => {
    setError(null);
    setWarnings([]);
    try {
      const parsed = parseSubtitleFile({ name: file.name, text: await file.text() });
      if (parsed.cues.length === 0) {
        setError("No valid subtitle cues were found in the subtitle file");
        return;
      }
      const canvas = editor.getState().doc.settings.canvasSize;
      const measure = canvasLineMeasurer(context2d(createCanvas(8, 8)));
      const elements = parsed.cues.map((cue, i) => buildCaptionElement({ cue, index: i, id: editor.newId(), canvas, measure }));
      if (!runEdit(editor, insertElementsOnLanes({ elements, index: 0, label: "Import captions" }))) return;
      const notes = [...parsed.warnings];
      if (parsed.skipped > 0) notes.push(`${parsed.skipped} cue${parsed.skipped === 1 ? "" : "s"} could not be read and were skipped`);
      setWarnings(notes);
      toast.success(`Added ${parsed.cues.length} captions`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not read the subtitle file");
    }
  };

  return (
    <ViewShell title="Captions" actions={
      <>
        <Button variant="outline" size="sm" onClick={() => input.current?.click()}><Icon name="upload" />Import</Button>
        <input ref={input} type="file" accept=".srt,.ass,.ssa" hidden aria-label="Import subtitle file"
          onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) void importFile(f); }} />
      </>
    }>
      <p className="muted" style={{ lineHeight: 1.5 }}>Import an .srt or .ass file to add one text clip per caption on new text tracks at the top of the timeline. Overlapping captions get their own track.</p>
      <TranslateCaptions />
      {error ? <div className="alert alert--destructive" role="alert" style={{ marginTop: 12 }}>{error}</div> : null}
      {warnings.length > 0 ? (
        <div className="alert alert--caution" style={{ marginTop: 12, flexDirection: "column", gap: 4 }}>
          {warnings.map((w) => <span key={w}>{w}</span>)}
        </div>
      ) : null}
    </ViewShell>
  );
}
