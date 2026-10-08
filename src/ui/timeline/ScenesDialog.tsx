import { useState, type ReactNode } from "react";
import { createSceneCommand, deleteSceneCommand, renameSceneCommand } from "#/engine/commands";
import type { Scene } from "#/engine/model";
import { getServices } from "#/app/services";
import { Icon } from "../icons";
import { Button } from "../primitives/Button";
import { Dialog } from "../primitives/Dialog";
import { toast } from "../primitives/toast";
import { runEdit } from "../lib/edit";

export function ScenesDialog({ open, onClose, scenes, currentId }: { open: boolean; onClose: () => void; scenes: Scene[]; currentId: string }): ReactNode {
  const { editor } = getServices();
  const [name, setName] = useState("");
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameText, setRenameText] = useState("");

  const create = (): void => {
    const trimmed = name.trim() || `Scene ${scenes.length + 1}`;
    runEdit(editor, createSceneCommand({ name: trimmed }));
    setName("");
  };
  const remove = (scene: Scene): void => {
    try {
      runEdit(editor, deleteSceneCommand(scene.id));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not delete the scene");
    }
  };
  const rename = (scene: Scene): void => {
    const trimmed = renameText.trim();
    if (trimmed && trimmed !== scene.name) runEdit(editor, renameSceneCommand(scene.id, trimmed));
    setRenaming(null);
  };

  return (
    <Dialog open={open} onClose={onClose} title="Scenes" description="Switch between scenes in your project"
      footer={<Button variant="outline" onClick={onClose}>Close</Button>}>
      <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 8 }}>
        {scenes.map((scene) => (
          <li key={scene.id} style={{ display: "flex", gap: 8, alignItems: "center" }}>
            {renaming === scene.id ? (
              <input className="input input--sm" aria-label="Scene name" value={renameText} autoFocus onChange={(e) => setRenameText(e.target.value)}
                onBlur={() => rename(scene)} onKeyDown={(e) => { if (e.key === "Enter") rename(scene); if (e.key === "Escape") setRenaming(null); }} />
            ) : (
              <Button variant="outline" className={scene.id === currentId ? "" : ""} style={{ flex: 1, justifyContent: "flex-start", ...(scene.id === currentId ? { borderColor: "var(--primary)", color: "var(--primary)" } : {}) }}
                onClick={() => { editor.switchScene(scene.id); onClose(); }} aria-current={scene.id === currentId}>
                {scene.id === currentId ? <Icon name="check" /> : null}{scene.name}{scene.isMain ? " (main)" : ""}
              </Button>
            )}
            <Button variant="ghost" size="icon" label={`Rename ${scene.name}`} onClick={() => { setRenaming(scene.id); setRenameText(scene.name); }}><Icon name="edit" /></Button>
            <Button variant="ghost" size="icon" label={`Delete ${scene.name}`} disabled={scene.isMain} onClick={() => remove(scene)}><Icon name="trash" /></Button>
          </li>
        ))}
      </ul>
      <div style={{ display: "flex", gap: 8 }}>
        <input className="input" aria-label="New scene name" placeholder="New scene name" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") create(); }} />
        <Button onClick={create}><Icon name="plus" />Add</Button>
      </div>
    </Dialog>
  );
}
