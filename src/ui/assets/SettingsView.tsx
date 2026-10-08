import { useState, type ReactNode } from "react";
import { updateSettings } from "#/engine/commands";
import { CANVAS_PRESETS, type Background } from "#/engine/model";
import { frameRateFromFloat, frameRateToFloat, isSameFrameRate, type FrameRate } from "#/engine/time";
import { getServices } from "#/app/services";
import { useEditorState, useSettings } from "#/app/hooks";
import { Icon } from "../icons";
import { NumberField, Section, SelectField, Tabs, ColorField } from "../primitives/fields";
import { toast } from "../primitives/toast";
import { runEdit } from "../lib/edit";

const FPS_PRESETS = [24, 25, 30, 60, 120];
const BLUR_PRESETS = [{ label: "Light", value: 100 }, { label: "Medium", value: 200 }, { label: "Heavy", value: 500 }];
const SWATCHES = ["#ffffff", "#000000", "#ef4444", "#f97316", "#f59e0b", "#eab308", "#84cc16", "#22c55e", "#14b8a6", "#06b6d4", "#3b82f6", "#6366f1", "#8b5cf6", "#d946ef", "#ec4899", "#64748b", "#1e293b"];

function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b);
}
export function aspectLabel(width: number, height: number): string {
  const g = gcd(width, height);
  return `${width / g}:${height / g}`;
}

function AspectOption({ w, h, selected, onClick, label }: { w: number; h: number; selected: boolean; onClick: () => void; label: string }): ReactNode {
  const max = 16;
  const scale = max / Math.max(w, h);
  return (
    <button type="button" role="radio" aria-checked={selected} className="option-row" onClick={onClick}>
      <span style={{ width: max, height: max, display: "grid", placeItems: "center" }}>
        <span className="option-row__shape" style={{ width: w * scale, height: h * scale }} />
      </span>
      <span style={{ flex: 1 }}>{label}</span>
      {selected ? <Icon name="check" size={14} /> : null}
    </button>
  );
}

function ProjectInfo(): ReactNode {
  const { editor } = getServices();
  const settings = useSettings();
  const name = useEditorState((s) => s.meta?.name ?? "");
  const [custom, setCustom] = useState(settings.canvasSizeMode === "custom");
  const { width, height } = settings.canvasSize;
  const fpsValue = frameRateToFloat(settings.fps);
  const fpsOptions = [...new Set([...FPS_PRESETS, Math.round(fpsValue * 1000) / 1000])].sort((a, b) => a - b);
  const setCanvas = (w: number, h: number, mode: "preset" | "custom"): void => {
    if (w < 16 || h < 16) { toast.error("Canvas size must be at least 16 pixels"); return; }
    runEdit(editor, updateSettings({ canvasSize: { width: Math.round(w), height: Math.round(h) }, canvasSizeMode: mode }));
  };
  return (
    <>
      <div className="row-between"><span className="label">Name</span><span className="truncate" style={{ maxWidth: 160 }}>{name}</span></div>
      <div className="row-between">
        <span className="label">Frame rate</span>
        <div style={{ width: 110 }}>
          <SelectField label="Frame rate" value={String(Math.round(fpsValue * 1000) / 1000)} onChange={(v) => {
            const next: FrameRate = frameRateFromFloat(Number(v));
            if (!isSameFrameRate(next, settings.fps)) runEdit(editor, updateSettings({ fps: next }));
          }} options={fpsOptions.map((f) => ({ value: String(f), label: `${f} fps` }))} />
        </div>
      </div>
      <Section sectionKey="settings:aspect-ratio" title="Aspect ratio" defaultOpen>
        <div role="radiogroup" aria-label="Aspect ratio" style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          {CANVAS_PRESETS.map((p) => (
            <AspectOption key={`${p.width}x${p.height}`} w={p.width} h={p.height} label={`${aspectLabel(p.width, p.height)}  (${p.width}×${p.height})`}
              selected={!custom && width === p.width && height === p.height} onClick={() => { setCustom(false); setCanvas(p.width, p.height, "preset"); }} />
          ))}
          <AspectOption w={1} h={1} label="Custom" selected={custom || !CANVAS_PRESETS.some((p) => p.width === width && p.height === height)} onClick={() => setCustom(true)} />
        </div>
        {custom || !CANVAS_PRESETS.some((p) => p.width === width && p.height === height) ? (
          <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
            <NumberField label="Canvas width" value={width} min={16} max={7680} step={1} icon="arrow-right" onCommit={(v) => setCanvas(v, height, "custom")} />
            <NumberField label="Canvas height" value={height} min={16} max={7680} step={1} icon="arrow-down" onCommit={(v) => setCanvas(width, v, "custom")} />
          </div>
        ) : null}
      </Section>
    </>
  );
}

function BackgroundSettings(): ReactNode {
  const { editor } = getServices();
  const bg = useSettings().background;
  const set = (background: Background, mode: "preview" | "commit"): void => {
    const cmd = updateSettings({ background });
    if (mode === "preview") editor.preview(cmd);
    else runEdit(editor, cmd);
  };
  return (
    <>
      <Section sectionKey="settings:blur" title="Blur" defaultOpen>
        <div className="swatches">
          {BLUR_PRESETS.map((p) => (
            <button key={p.label} type="button" className="swatch" aria-pressed={bg.type === "blur" && bg.blurIntensity === p.value} aria-label={`${p.label} blur background`}
              style={{ width: 80, height: 80, background: "linear-gradient(135deg,#2567ec,#37b6f7,#ba5d7a)", filter: "none", position: "relative", overflow: "hidden" }}
              onClick={() => set({ type: "blur", blurIntensity: p.value }, "commit")}>
              <span style={{ position: "absolute", inset: 0, backdropFilter: `blur(${p.value / 25}px)` }} />
              <span style={{ position: "absolute", left: 4, bottom: 4, background: "rgba(0,0,0,0.5)", color: "#fff", padding: "0 4px", fontSize: 11 }}>{p.label}</span>
            </button>
          ))}
        </div>
      </Section>
      <Section sectionKey="settings:colors" title="Colors" defaultOpen={false}>
        <div className="swatches">
          {SWATCHES.map((c) => (
            <button key={c} type="button" className="swatch" aria-label={`Background ${c}`} aria-pressed={bg.type === "color" && bg.color === c}
              style={{ background: c }} onClick={() => set({ type: "color", color: c }, "commit")} />
          ))}
        </div>
        <div style={{ marginTop: 12 }}>
          <ColorField label="Custom background color" value={bg.type === "color" ? bg.color : "#000000"}
            onPreview={(c) => set({ type: "color", color: c }, "preview")} onChange={(c) => set({ type: "color", color: c }, "commit")} />
        </div>
      </Section>
    </>
  );
}

export function SettingsView(): ReactNode {
  const [tab, setTab] = useState<"info" | "background">("info");
  return (
    <div className="assets__view">
      <div className="view__header">
        <Tabs label="Settings" value={tab} onChange={setTab} tabs={[{ value: "info", label: "Project info" }, { value: "background", label: "Background" }]} />
      </div>
      <div className="view__body scrollbar-hidden" style={{ padding: 0 }}>{tab === "info" ? <ProjectInfo /> : <BackgroundSettings />}</div>
    </div>
  );
}
