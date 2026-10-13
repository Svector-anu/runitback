import { useEffect } from "react";
import {
  defaultKeybindings, isTypableTarget, parseKeybindings, resolveAction, runAction, type ActionId, type Keybindings,
} from "#/engine/editor";
import { getOverlayDepth } from "#/ui/primitives/overlay-store";
import { toast } from "#/ui/primitives/toast";
import { getServices } from "./services";
import { shouldYieldToFocusedControl } from "./shortcut-guard";
import { Store } from "./store";
import { interactionStore } from "#/ui/timeline/controllers";

export const keybindingsStore = new Store<{ bindings: Keybindings; customized: boolean }>({ bindings: defaultKeybindings(), customized: false });

const isApple = (): boolean => typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

export function loadKeybindings(): void {
  const stored = getServices().prefs.read<Keybindings | null>("keybindings", null, (v): v is Keybindings => parseKeybindings(v) !== null);
  if (stored) keybindingsStore.set({ bindings: stored, customized: true });
}

export function saveKeybindings(bindings: Keybindings): void {
  keybindingsStore.set({ bindings, customized: true });
  getServices().prefs.write("keybindings", bindings);
}

export function resetKeybindings(): void {
  keybindingsStore.set({ bindings: defaultKeybindings(), customized: false });
  getServices().prefs.write("keybindings", null);
}

export function invokeAction(action: ActionId): boolean {
  const { editor, prefs } = getServices();
  const handled = runAction(editor, action, {
    nowMs: () => performance.now(),
    onRejected: (error) => toast.error("That change could not be applied", error.message),
  });
  if (action === "toggle-snapping") prefs.write("snapping", editor.getState().snappingEnabled);
  if (action === "toggle-ripple-editing") prefs.write("ripple", editor.getState().rippleEnabled);
  return handled;
}

/** Global shortcut listener. Suspended while typing, while a dialog/menu is open, or while no project is loaded. */
export function useKeyboardShortcuts(options: { enabled: boolean; recording: boolean }): void {
  useEffect(() => {
    if (!options.enabled) return undefined;
    const onKeyDown = (e: KeyboardEvent): void => {
      if (options.recording || getOverlayDepth() > 0) return;
      const target = e.target as HTMLElement | null;
      if (e.key === "Escape" && isTypableTarget(target)) {
        target?.blur();
        return;
      }
      if (isTypableTarget(target)) return;
      if (target?.closest("[data-owns-keys]")) return;
      if (shouldYieldToFocusedControl(e, target)) return;
      if (target?.closest("[role='slider'], [role='separator'], select") && (e.key.startsWith("Arrow") || e.key === "Home" || e.key === "End")) return;
      const action = resolveAction(e, keybindingsStore.get().bindings, isApple());
      if (!action) return;
      if (action === "paste-copied" && !getServices().editor.getState().hasClipboard) return;
      if (action === "cancel-interaction" && interactionStore.get().mode !== "idle") return;
      e.preventDefault();
      invokeAction(action);
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [options.enabled, options.recording]);
}
