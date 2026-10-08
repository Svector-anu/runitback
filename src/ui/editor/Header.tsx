import { useEffect, useRef, useState, type ReactNode } from "react";
import { getServices } from "#/app/services";
import { navigate } from "#/app/router";
import { useEditorState, useSaveState } from "#/app/hooks";
import { setTheme, uiStore } from "#/app/ui-state";
import { Icon, Logo } from "../icons";
import { Button } from "../primitives/Button";
import { Dialog } from "../primitives/Dialog";
import { DropdownMenu } from "../primitives/Menu";
import { toast } from "../primitives/toast";
import { ExportButton } from "./ExportButton";
import { ShortcutsDialog } from "./ShortcutsDialog";

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
    await services.closeProject();
    navigate("/projects");
  };
  const remove = async (): Promise<void> => {
    if (!meta) return;
    const id = meta.id;
    await services.closeProject();
    await services.projects.delete([id]);
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
