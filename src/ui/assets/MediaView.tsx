import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { isTypableTarget } from "#/engine/editor";
import type { MediaAssetInfo } from "#/engine/model";
import { TICKS_PER_SECOND } from "#/engine/time";
import { getServices } from "#/app/services";
import { insertPayload } from "#/app/insert";
import { useAssets } from "#/app/hooks";
import { uiStore } from "#/app/ui-state";
import { getTranscribeService } from "#/app/transcribe-service";
import { beginDrag, endDrag, hasFiles } from "../dnd";
import { Icon } from "../icons";
import { Button } from "../primitives/Button";
import { ContextMenu, DropdownMenu, type ContextMenuState } from "../primitives/Menu";
import { toast } from "../primitives/toast";
import { reportInsert } from "../lib/edit";
import { TranscribeDialog } from "./TranscribeDialog";
import { transcribeWithToast } from "./transcribe-action";

export function formatDuration(ticks: number): string {
  const total = Math.round(ticks / TICKS_PER_SECOND);
  const m = Math.floor(total / 60);
  const s = String(total % 60).padStart(2, "0");
  return `${m}:${s}`;
}

export function shortName(name: string): string {
  return name.length <= 8 ? name : `${name.slice(0, 16)}...${name.slice(-3)}`;
}

export async function importAndReport(files: ReadonlyArray<File>, onProgress?: (done: number, total: number) => void): Promise<MediaAssetInfo[]> {
  const services = getServices();
  if (!services.editor.hasProject) {
    toast.error("No active project");
    return [];
  }
  const outcome = await services.importFiles(files, onProgress);
  for (const failure of outcome.failures) toast.error(`Failed to upload ${failure.name}`, failure.message);
  if (outcome.imported.length === 1) toast.success(`${outcome.imported[0]?.name} has been uploaded`);
  else if (outcome.imported.length > 1) toast.success(`${outcome.imported.length} media assets have been uploaded`);
  return outcome.imported;
}

function Tile({ asset }: { asset: MediaAssetInfo }): ReactNode {
  return (
    <>
      {asset.thumbnail ? <img src={asset.thumbnail} alt="" draggable={false} /> : asset.type === "audio" ? (
        <div style={{ display: "grid", placeItems: "center", gap: 2, border: "1px solid var(--border)", width: "100%", height: "100%" }}>
          <Icon name="music" size={24} /><span style={{ fontSize: "var(--text-xs)" }}>Audio</span>
        </div>
      ) : <Icon name={asset.type === "video" ? "video" : "image"} size={24} />}
      {asset.type !== "image" && asset.duration ? <span className="media-item__badge">{formatDuration(asset.duration)}</span> : null}
    </>
  );
}

export function MediaView(): ReactNode {
  const services = getServices();
  const { editor } = services;
  const assets = useAssets();
  const view = uiStore.use((s) => s.mediaView);
  const sort = uiStore.use((s) => s.mediaSort);
  const desc = uiStore.use((s) => s.mediaSortDesc);
  const selected = uiStore.use((s) => s.selectedAssetIds);
  const reveal = uiStore.use((s) => s.revealMediaId);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [menu, setMenu] = useState<ContextMenuState | null>(null);
  const [highlight, setHighlight] = useState<string | null>(null);
  const [consentFor, setConsentFor] = useState<MediaAssetInfo | null>(null);
  const transcribeService = getTranscribeService();
  const transcribeJobs = transcribeService.state.use((s) => s.jobs);
  const input = useRef<HTMLInputElement>(null);
  const anchor = useRef<string | null>(null);
  const depth = useRef(0);

  const sorted = useMemo(() => {
    const list = [...assets];
    const cmp = (a: MediaAssetInfo, b: MediaAssetInfo): number =>
      sort === "name" ? a.name.localeCompare(b.name) : sort === "type" ? a.type.localeCompare(b.type) || a.name.localeCompare(b.name)
        : sort === "duration" ? (a.duration ?? 0) - (b.duration ?? 0) : a.size - b.size;
    list.sort((a, b) => (desc ? -cmp(a, b) : cmp(a, b)));
    return list;
  }, [assets, sort, desc]);

  useEffect(() => {
    if (!reveal) return undefined;
    setHighlight(reveal);
    uiStore.set({ revealMediaId: null });
    document.querySelector(`[data-asset-id="${CSS.escape(reveal)}"]`)?.scrollIntoView({ block: "nearest" });
    const timer = setTimeout(() => setHighlight(null), 1500);
    return () => clearTimeout(timer);
  }, [reveal]);

  useEffect(() => {
    const onPaste = (e: ClipboardEvent): void => {
      if (editor.getState().hasClipboard || isTypableTarget(e.target as HTMLElement | null)) return;
      const files = [...(e.clipboardData?.files ?? [])];
      if (files.length === 0) return;
      e.preventDefault();
      void run(files);
    };
    document.addEventListener("paste", onPaste);
    return () => document.removeEventListener("paste", onPaste);
  }, [editor]);

  const run = async (files: File[]): Promise<void> => {
    setProgress({ done: 0, total: files.length });
    try {
      await importAndReport(files, (done, total) => setProgress({ done, total }));
    } finally {
      setProgress(null);
    }
  };

  const select = (e: React.MouseEvent, id: string): void => {
    const current = uiStore.get().selectedAssetIds;
    if (e.shiftKey && anchor.current) {
      const a = sorted.findIndex((x) => x.id === anchor.current);
      const b = sorted.findIndex((x) => x.id === id);
      const [lo, hi] = a < b ? [a, b] : [b, a];
      const range = sorted.slice(lo, hi + 1).map((x) => x.id);
      uiStore.set({ selectedAssetIds: e.ctrlKey || e.metaKey ? [...new Set([...current, ...range])] : range });
    } else if (e.ctrlKey || e.metaKey) {
      uiStore.set({ selectedAssetIds: current.includes(id) ? current.filter((x) => x !== id) : [...current, id] });
      anchor.current = id;
    } else {
      uiStore.set({ selectedAssetIds: [id] });
      anchor.current = id;
    }
  };

  const add = (asset: MediaAssetInfo): void => {
    reportInsert(insertPayload({ editor, payload: { kind: "media", assetId: asset.id, mediaType: asset.type }, startTime: editor.playback.getState().currentTime }));
  };

  const transcribe = (asset: MediaAssetInfo): void => {
    if (asset.id in transcribeJobs) { transcribeService.cancel(asset.id); return; }
    void transcribeWithToast({ assetId: asset.id, assetName: asset.name }).then((status) => { if (status === "needs-consent") setConsentFor(asset); });
  };

  const confirmDownload = (): void => {
    const asset = consentFor;
    setConsentFor(null);
    if (!asset) return;
    transcribeService.grantConsent();
    void transcribeWithToast({ assetId: asset.id, assetName: asset.name });
  };

  const removeSelected = (ids: string[]): void => {
    const removed = services.removeAssets(ids);
    if (!removed.ok) { toast.error("Could not remove that media", removed.error.message); return; }
    uiStore.set({ selectedAssetIds: [] });
  };

  const sortLabel = { name: "Name", type: "Type", duration: "Duration", size: "File size" } as const;
  const setSort = (key: typeof sort): void => {
    if (key === sort) uiStore.set({ mediaSortDesc: !desc });
    else uiStore.set({ mediaSort: key, mediaSortDesc: false });
    services.prefs.write("media-sort", uiStore.get().mediaSort);
    services.prefs.write("media-sort-desc", uiStore.get().mediaSortDesc);
  };
  const setView = (v: "grid" | "list"): void => {
    uiStore.set({ mediaView: v });
    services.prefs.write("media-view", v);
  };

  return (
    <div
      className="assets__view" data-dragover={dragOver}
      onDragEnter={(e) => { if (hasFiles(e)) { depth.current++; setDragOver(true); } }}
      onDragLeave={() => { depth.current = Math.max(0, depth.current - 1); if (depth.current === 0) setDragOver(false); }}
      onDragOver={(e) => { if (hasFiles(e)) e.preventDefault(); }}
      onDrop={(e) => { if (!hasFiles(e)) return; e.preventDefault(); depth.current = 0; setDragOver(false); void run([...e.dataTransfer.files]); }}
    >
      <div className="view__header">
        <span className="view__title">Assets</span>
        <div className="view__actions">
          <Button variant="ghost" size="icon" label={view === "grid" ? "Switch to list view" : "Switch to grid view"} disabled={!!progress} onClick={() => setView(view === "grid" ? "list" : "grid")}>
            <Icon name={view === "grid" ? "list" : "grid"} />
          </Button>
          <DropdownMenu align="end" width={160}
            entries={(Object.keys(sortLabel) as Array<keyof typeof sortLabel>).map((k) => ({ label: `${sortLabel[k]}${k === sort ? (desc ? " ↓" : " ↑") : ""}`, onSelect: () => setSort(k) }))}
            trigger={(p) => <Button {...p} variant="ghost" size="icon" label={`Sort by ${sort} (${desc ? "descending" : "ascending"})`} disabled={!!progress}><Icon name="arrow-up-down" /></Button>} />
          <Button variant="outline" size="sm" disabled={!!progress} onClick={() => input.current?.click()}><Icon name="upload" />Import</Button>
          <input ref={input} type="file" multiple accept="image/*,video/*,audio/*" hidden aria-label="Import media files"
            onChange={(e) => { const files = [...(e.target.files ?? [])]; e.target.value = ""; if (files.length) void run(files); }} />
        </div>
      </div>
      <div className="view__body scrollbar-hidden" onPointerDown={(e) => { if (e.target === e.currentTarget) uiStore.set({ selectedAssetIds: [] }); }}>
        {sorted.length === 0 || progress ? (
          <button type="button" className="dropzone" disabled={!!progress} onClick={() => input.current?.click()}>
            <Icon name="upload" />
            <span>{progress ? `Processing your files (${Math.round((progress.done / progress.total) * 100)}%)` : "Drag and drop videos, photos, and audio files here"}</span>
            {progress ? <div className="progress" style={{ width: "100%" }}><div style={{ width: `${(progress.done / progress.total) * 100}%` }} /></div> : null}
          </button>
        ) : null}
        {sorted.length > 0 && view === "grid" ? (
          <div className={`media-grid`} style={{ marginTop: progress ? 16 : 0 }}>
            {sorted.map((asset) => (
              <div key={asset.id} className="media-item" data-asset-id={asset.id} data-selected={selected.includes(asset.id)} data-highlight={highlight === asset.id}
                draggable role="group" tabIndex={0} aria-label={`${asset.type} ${asset.name}`} aria-roledescription="media item"
                onDragStart={(e) => beginDrag(e, { kind: "media", assetId: asset.id, mediaType: asset.type })} onDragEnd={endDrag}
                onClick={(e) => select(e, asset.id)}
                onKeyDown={(e) => { if (e.key === "Enter") add(asset); if (e.key === " ") { e.preventDefault(); select(e as unknown as React.MouseEvent, asset.id); } }}
                onContextMenu={(e) => { e.preventDefault(); if (!selected.includes(asset.id)) uiStore.set({ selectedAssetIds: [asset.id] }); setMenu({ x: e.clientX, y: e.clientY }); }}>
                <div className="media-item__tile">
                  <Tile asset={asset} />
                  {asset.type !== "image" ? (
                    <button type="button" className="media-item__transcribe" data-busy={asset.id in transcribeJobs}
                      aria-label={asset.id in transcribeJobs ? `Cancel transcription of ${asset.name}` : `Transcribe ${asset.name}`}
                      onClick={(e) => { e.stopPropagation(); transcribe(asset); }}>
                      {asset.id in transcribeJobs ? `${Math.round((transcribeJobs[asset.id] ?? 0) * 100)}%` : <Icon name="captions" />}
                    </button>
                  ) : null}
                  <button type="button" className="media-item__add" aria-label={`Add ${asset.name} to timeline`} onClick={(e) => { e.stopPropagation(); add(asset); }}><Icon name="plus" /></button>
                </div>
                <div className="media-item__name truncate" title={asset.name}>{shortName(asset.name)}</div>
              </div>
            ))}
          </div>
        ) : null}
        {sorted.length > 0 && view === "list" ? (
          <div className="media-list">
            {sorted.map((asset) => (
              <div key={asset.id} className="media-row" data-asset-id={asset.id} data-selected={selected.includes(asset.id)} draggable role="button" tabIndex={0}
                onDragStart={(e) => beginDrag(e, { kind: "media", assetId: asset.id, mediaType: asset.type })} onDragEnd={endDrag}
                onClick={(e) => select(e, asset.id)} onDoubleClick={() => add(asset)}
                onContextMenu={(e) => { e.preventDefault(); if (!selected.includes(asset.id)) uiStore.set({ selectedAssetIds: [asset.id] }); setMenu({ x: e.clientX, y: e.clientY }); }}>
                <div className="media-row__preview">{asset.thumbnail ? <img src={asset.thumbnail} alt="" /> : null}</div>
                <span className="truncate" style={{ flex: 1 }}>{asset.name}</span>
              </div>
            ))}
          </div>
        ) : null}
      </div>
      <ContextMenu state={menu} onClose={() => setMenu(null)} width={176}
        entries={[
          { label: selected.length > 1 ? `Add ${selected.length} items to timeline` : "Add to timeline", icon: "plus",
            onSelect: () => { for (const id of selected) { const a = assets.find((x) => x.id === id); if (a) add(a); } } },
          ...(selected.length === 1 && assets.find((a) => a.id === selected[0])?.type !== "image"
            ? [{ label: "Transcribe", icon: "captions" as const, onSelect: () => { const a = assets.find((x) => x.id === selected[0]); if (a) transcribe(a); } }]
            : []),
          { type: "separator" },
          { label: selected.length > 1 ? `Delete ${selected.length} items` : "Delete", icon: "trash", destructive: true, onSelect: () => removeSelected(selected) },
        ]} />
      <TranscribeDialog assetName={consentFor?.name ?? null} onConfirm={confirmDownload} onClose={() => setConsentFor(null)} />
    </div>
  );
}
