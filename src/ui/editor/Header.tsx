import { useEffect, useRef, useState, type ReactNode } from "react";
import { getServices } from "#/app/services";
import { navigate } from "#/app/router";
import { useEditorState, useSaveState } from "#/app/hooks";
import { setTheme, uiStore } from "#/app/ui-state";
import { Icon } from "../icons";
import { Logo } from "../brand/Logo";
import { Button } from "../primitives/Button";
import { Dialog } from "../primitives/Dialog";
import { DropdownMenu } from "../primitives/Menu";
import { toast } from "../primitives/toast";
import { ExportButton } from "./ExportButton";
import { ShortcutsDialog } from "./ShortcutsDialog";
import { ANTHROPIC_KEYS_URL } from "../lib/links";
import { getHintStore } from "../lib/hints";
import { getTourStore } from "../lib/tour";

function EditableProjectName(): ReactNode {
  const services = getServices();
  const name = useEditorState((s) => s.meta?.name ?? "");
  const [draft, setDraft] = useState(name);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => setDraft(name), [name]);

  const commit = async (): Promise<void> => {
    const trimmed = draft.trim();
    if (!trimmed || trimmed === name) { setDraft(name); return; }
    services.editor.updateMetadata({ name: trimmed });
  };
  return (
    <input
      ref={input} className="name-input" aria-label="Project name" value={draft} spellCheck={false}
      onFocus={(e) => e.currentTarget.select()} onChange={(e) => setDraft(e.target.value)} onBlur={() => void commit()}
      onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); if (e.key === "Escape") { setDraft(name); e.currentTarget.blur(); } }}
    />
  );
}

function SaveIndicator(): ReactNode {
  const save = useSaveState();
  const label = save.status === "saving" ? "Saving…" : save.status === "dirty" ? "Unsaved changes" : save.status === "error" ? "Save failed, retrying" : "All changes saved";
  return (
    <span className="muted" role="status" aria-live="polite" style={{ fontSize: "var(--text-xs)", color: save.status === "error" ? "var(--destructive)" : undefined }} title={save.error ?? undefined}>
      {label}
    </span>
  );
}

export function EditorHeader({ onRecording }: { onRecording: (recording: boolean) => void }): ReactNode {
  const services = getServices();
  const theme = uiStore.use((s) => s.theme);
  const [shortcuts, setShortcuts] = useState(false);
  const [exiting, setExiting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const meta = useEditorState((s) => s.meta);

  const exit = async (): Promise<void> => {
    setExiting(true);
    try {
      await services.closeProject();
    } catch (error) {
      setExiting(false);
      toast.error("Could not save your latest changes", error instanceof Error ? error.message : undefined);
      return;
    }
    navigate("/projects");
  };
  const remove = async (): Promise<void> => {
    if (!meta) return;
    const id = meta.id;
    try {
      await services.closeProject();
      await services.projects.delete([id]);
    } catch (error) {
      toast.error("Could not delete the project", error instanceof Error ? error.message : undefined);
      return;
    }
    navigate("/projects");
    toast.success("Project deleted");
  };

  return (
    <header className="editor__header">
      <div className="editor__header-left">
        <DropdownMenu width={176}
          entries={[
            { label: "Exit project", icon: "log-out", disabled: exiting, onSelect: () => void exit() },
            { label: "Keyboard shortcuts", icon: "command", onSelect: () => setShortcuts(true) },
            { type: "separator" },
            { label: "Delete project", icon: "trash", destructive: true, onSelect: () => setConfirmDelete(true) },
          ]}
          trigger={(p) => <Button {...p} variant="ghost" size="icon-lg" label="Project menu"><Logo size={20} /></Button>} />
        <EditableProjectName />
        <SaveIndicator />
      </div>
      <nav className="editor__header-right" aria-label="Editor actions">
        <DropdownMenu width={224} align="end"
          entries={[
            { label: "Take the tour", icon: "film", onSelect: () => getTourStore().start() },
            { label: "Keyboard shortcuts", icon: "command", onSelect: () => setShortcuts(true) },
            { label: "Show tips again", icon: "reset", onSelect: () => { getHintStore().reset(); toast.info("Tips are back", "Each one will show once more when it applies."); } },
            { type: "separator" },
            { label: "Get an Anthropic API key", icon: "link", onSelect: () => { window.open(ANTHROPIC_KEYS_URL, "_blank", "noopener,noreferrer"); } },
          ]}
          trigger={(p) => <Button {...p} variant="ghost" size="icon-lg" label="Help and tips" className="help-button" data-testid="help-button"><span aria-hidden="true">?</span></Button>} />
        <Button variant="ghost" size="icon-lg" label={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"} onClick={() => setTheme(theme === "dark" ? "light" : "dark")}>
          <Icon name={theme === "dark" ? "sun" : "moon"} size={18} />
        </Button>
        <ExportButton />
      </nav>
      <ShortcutsDialog open={shortcuts} onClose={() => setShortcuts(false)} onRecording={onRecording} />
      <Dialog open={confirmDelete} onClose={() => setConfirmDelete(false)} title={`Delete '${meta?.name ?? ""}'?`}
        description="This will permanently delete the project and all of its media from this browser."
        footer={<><Button variant="outline" onClick={() => setConfirmDelete(false)}>Cancel</Button><Button variant="destructive" onClick={() => void remove()}>Delete project</Button></>} />
    </header>
  );
}
