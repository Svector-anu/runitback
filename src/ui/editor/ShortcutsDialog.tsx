import { useEffect, useState, type ReactNode } from "react";
import { ACTIONS, findConflict, rebind, keybindingString, type ActionId, type ActionCategory } from "#/engine/editor";
import { keybindingsStore, resetKeybindings, saveKeybindings } from "#/app/actions";
import { Button } from "../primitives/Button";
import { Dialog } from "../primitives/Dialog";
import { toast } from "../primitives/toast";

const isApple = (): boolean => /Mac|iPhone|iPad/.test(navigator.platform);
const CATEGORY_ORDER: ActionCategory[] = ["playback", "navigation", "editing", "selection", "history", "timeline", "controls", "assets"];

export function prettyKey(key: string): string {
  return key.split("+").map((part) => {
    if (part === "ctrl") return isApple() ? "⌘" : "Ctrl";
    const named: Record<string, string> = { right: "→", left: "←", up: "↑", down: "↓", space: "Space", escape: "Esc", backspace: "Backspace", delete: "Delete", enter: "Enter", home: "Home", end: "End", shift: "Shift", alt: isApple() ? "⌥" : "Alt" };
    return named[part] ?? part.toUpperCase();
  }).join(" + ");
}

export function ShortcutsDialog({ open, onClose, onRecording }: { open: boolean; onClose: () => void; onRecording: (recording: boolean) => void }): ReactNode {
  const { bindings, customized } = keybindingsStore.use((s) => s);
  const [recording, setRecording] = useState<{ action: ActionId; oldKey: string } | null>(null);

  useEffect(() => {
    onRecording(recording !== null);
    if (!recording) return undefined;
    const onKey = (e: KeyboardEvent): void => {
      e.preventDefault();
      e.stopPropagation();
      if (["Shift", "Control", "Alt", "Meta"].includes(e.key)) return;
      if (e.key === "Escape") { setRecording(null); return; }
      const key = keybindingString(e, isApple());
      const conflict = findConflict(bindings, key, recording.action);
      if (conflict) {
        toast.error(`Key "${prettyKey(key)}" is already bound to "${ACTIONS[conflict].description}"`);
        return;
      }
      saveKeybindings(rebind(bindings, recording.action, key));
      setRecording(null);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [recording, bindings, onRecording]);

  const grouped = CATEGORY_ORDER.map((category) => ({
    category,
    items: (Object.keys(ACTIONS) as ActionId[]).filter((a) => ACTIONS[a].category === category)
      .map((action) => ({ action, keys: Object.entries(bindings).filter(([, a]) => a === action).map(([k]) => k) }))
      .filter((i) => i.keys.length > 0 || ACTIONS[i.action].category === category),
  })).filter((g) => g.items.length > 0);

  return (
    <Dialog open={open} onClose={() => { setRecording(null); onClose(); }} title="Keyboard shortcuts" description="Click a shortcut to rebind it." wide
      footer={<Button variant="destructive-outline" disabled={!customized} onClick={() => resetKeybindings()}>Reset to default</Button>}>
      {grouped.map((group) => (
        <div key={group.category}>
          <div className="muted" style={{ fontSize: "var(--text-xs)", fontWeight: 500, letterSpacing: "0.05em", textTransform: "uppercase", marginBottom: 8 }}>{group.category}</div>
          {group.items.map(({ action, keys }) => (
            <div key={action} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "4px 0", gap: 8 }}>
              <span>{ACTIONS[action].description}</span>
              <span style={{ display: "flex", gap: 6, alignItems: "center" }}>
                {keys.length === 0 ? <span className="muted">Unassigned</span> : null}
                {keys.map((k, i) => (
                  <span key={k} style={{ display: "flex", gap: 6, alignItems: "center" }}>
                    {i > 0 ? <span className="muted">or</span> : null}
                    <Button variant="outline" size="sm" aria-label={`Rebind ${ACTIONS[action].description}, currently ${prettyKey(k)}`}
                      onClick={() => setRecording({ action, oldKey: k })}>
                      {recording?.action === action && recording.oldKey === k ? "Press any key combination..." : prettyKey(k)}
                    </Button>
                  </span>
                ))}
                {keys.length === 0 ? <Button variant="outline" size="sm" onClick={() => setRecording({ action, oldKey: "" })}>{recording?.action === action ? "Press any key combination..." : "Set"}</Button> : null}
              </span>
            </div>
          ))}
        </div>
      ))}
    </Dialog>
  );
}
