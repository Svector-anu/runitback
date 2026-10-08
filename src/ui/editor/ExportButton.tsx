import { useEffect, useRef, useState, type ReactNode } from "react";
import { exportFileName, DEFAULT_EXPORT_OPTIONS, type ExportOptions } from "#/export/plan";
import { ExportCanceledError, exportProject, type ExportProgress } from "#/export/exporter";
import { getServices } from "#/app/services";
import { useEditorState } from "#/app/hooks";
import { totalDuration } from "#/engine/timeline";
import { currentScene } from "#/engine/commands";
import { Icon } from "../icons";
import { Button } from "../primitives/Button";
import { Popover } from "../primitives/Popover";
import { Section } from "../primitives/fields";
import { toast } from "../primitives/toast";

type State =
  | { kind: "idle" }
  | { kind: "exporting"; progress: ExportProgress }
  | { kind: "error"; message: string };

function Radio<T extends string>({ name, value, options, onChange }: { name: string; value: T; options: Array<{ value: T; label: string; hint: string }>; onChange: (v: T) => void }): ReactNode {
  return (
    <div role="radiogroup" aria-label={name} style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {options.map((o) => (
        <label key={o.value} style={{ display: "flex", gap: 8, alignItems: "flex-start", cursor: "pointer" }}>
          <input type="radio" name={name} checked={value === o.value} onChange={() => onChange(o.value)} style={{ marginTop: 2 }} />
          <span><span style={{ fontWeight: 500 }}>{o.label}</span><br /><span className="muted">{o.hint}</span></span>
        </label>
      ))}
    </div>
  );
}

export function download(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export function ExportButton(): ReactNode {
  const services = getServices();
  const anchor = useRef<HTMLButtonElement>(null);
  const abort = useRef<AbortController | null>(null);
  const [open, setOpen] = useState(false);
  const [options, setOptions] = useState<ExportOptions>(DEFAULT_EXPORT_OPTIONS);
  const [state, setState] = useState<State>({ kind: "idle" });
  const empty = useEditorState((s) => totalDuration(currentScene(s.doc).tracks) === 0);
  const name = useEditorState((s) => s.meta?.name ?? "export");

  useEffect(() => () => abort.current?.abort(), []);

  const start = async (): Promise<void> => {
    const controller = new AbortController();
    abort.current = controller;
    const untrack = services.trackExport(controller);
    services.editor.playback.pause();
    setState({ kind: "exporting", progress: { phase: "preparing", progress: 0 } });
    try {
      const result = await exportProject({
        doc: services.editor.getState().doc, getBlob: services.runtime.getBlob, options, signal: controller.signal,
        onProgress: (progress) => setState({ kind: "exporting", progress }),
      });
      download(result.blob, exportFileName(name, result.extension));
      toast.success("Export complete", `${result.width}×${result.height}, ${result.frameCount} frames${result.hasAudio ? ", with audio" : ""}`);
      setState({ kind: "idle" });
      setOpen(false);
    } catch (error) {
      if (error instanceof ExportCanceledError) setState({ kind: "idle" });
      else {
        const message = error instanceof Error ? error.message : String(error);
        setState({ kind: "error", message });
        toast.error("Export failed", message);
      }
    } finally {
      untrack();
      if (abort.current === controller) abort.current = null;
    }
  };

  /** Dismissing the popover never cancels a running export; only the Cancel button (or leaving the project) does. */
  const close = (): void => {
    setOpen(false);
    if (state.kind !== "exporting") setState({ kind: "idle" });
  };

  const exportingPercent = state.kind === "exporting" ? Math.round(state.progress.progress * 100) : null;

  return (
    <>
      <button ref={anchor} type="button" className="export-button" disabled={empty} aria-haspopup="dialog" aria-expanded={open}
        title={empty ? "Add media to the timeline to export" : exportingPercent === null ? "Export" : "Export in progress"} onClick={() => setOpen((o) => !o)}>
        <span className="export-button__inner">
          <Icon name="download" /><span>{exportingPercent === null ? "Export" : `Exporting ${exportingPercent}%`}</span>
        </span>
      </button>
      <Popover open={open} onClose={close} anchor={anchor} align="end" label="Export project" className="popover--padded">
        <div style={{ width: 320 }}>
          <div style={{ padding: 12, borderBottom: "1px solid var(--border)", fontWeight: 500 }}>
            {state.kind === "exporting" ? "Exporting project" : "Export project"}
          </div>
          {state.kind === "exporting" ? (
            <div style={{ padding: 12, display: "flex", flexDirection: "column", gap: 12 }}>
              <div style={{ display: "flex", justifyContent: "space-between" }} className="muted">
                <span aria-live="polite">{Math.round(state.progress.progress * 100)}%</span>
                <span>{state.progress.phase === "audio" ? "Mixing audio" : state.progress.phase === "finalizing" ? "Finishing" : state.progress.phase === "video" ? "Rendering frames" : "Preparing"}</span>
              </div>
              <div className="progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(state.progress.progress * 100)}>
                <div style={{ width: `${state.progress.progress * 100}%` }} />
              </div>
              <Button variant="outline" onClick={() => abort.current?.abort()}>Cancel</Button>
            </div>
          ) : (
            <>
              {state.kind === "error" ? (
                <div style={{ padding: 12, display: "flex", flexDirection: "column", gap: 8, borderBottom: "1px solid var(--border)" }} role="alert">
                  <span style={{ color: "var(--destructive)", fontWeight: 500 }}>Export failed</span>
                  <span className="muted">{state.message}</span>
                  <div style={{ display: "flex", gap: 8 }}>
                    <Button variant="outline" size="sm" style={{ flex: 1 }} onClick={() => void navigator.clipboard?.writeText(state.message)}><Icon name="copy" />Copy</Button>
                    <Button variant="outline" size="sm" style={{ flex: 1 }} onClick={() => void start()}><Icon name="reset" />Retry</Button>
                  </div>
                </div>
              ) : null}
              <Section sectionKey="export:format" title="Format" defaultOpen={false}>
                <Radio name="Format" value={options.format} onChange={(format) => setOptions({ ...options, format })}
                  options={[{ value: "mp4", label: "MP4 (H.264)", hint: "Better compatibility" }, { value: "webm", label: "WebM (VP9)", hint: "Smaller file size" }]} />
              </Section>
              <Section sectionKey="export:quality" title="Quality" defaultOpen={false}>
                <Radio name="Quality" value={options.quality} onChange={(quality) => setOptions({ ...options, quality })}
                  options={[{ value: "low", label: "Low", hint: "Smallest file size" }, { value: "medium", label: "Medium", hint: "Balanced" },
                    { value: "high", label: "High", hint: "Recommended" }, { value: "very_high", label: "Very high", hint: "Largest file size" }]} />
              </Section>
              <Section sectionKey="export:audio" title="Audio" defaultOpen={false}>
                <label style={{ display: "flex", gap: 8, alignItems: "center", cursor: "pointer" }}>
                  <input type="checkbox" className="checkbox" checked={options.includeAudio} onChange={(e) => setOptions({ ...options, includeAudio: e.target.checked })} />
                  Include audio in export
                </label>
              </Section>
              <div style={{ padding: 12 }}><Button style={{ width: "100%" }} onClick={() => void start()}><Icon name="download" />Export</Button></div>
            </>
          )}
        </div>
      </Popover>
    </>
  );
}
