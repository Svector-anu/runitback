import { frameDuration, mediaTime } from "#/engine/time";
import type { Command } from "#/engine/commands";
import type { EngineError } from "#/engine/model";
import { currentScene } from "#/engine/commands";
import {
  deleteElements, duplicateCommand, pasteCommand, splitCommand, splitTargets, toggleElementsHidden, toggleElementsMuted,
  toggleSourceAudio, toggleBookmark, canToggleSourceAudio,
} from "#/engine/commands";
import { getElement, selectAll } from "#/engine/timeline";
import type { ActionId } from "./actions";
import type { Editor } from "./editor";

export interface ActionEnv {
  /** Current wall-clock ms in the playback timebase. */
  nowMs: () => number;
  /** Called with the reason when an edit is refused; the editor is then unchanged. */
  onRejected?: (error: EngineError) => void;
}

/** Executes an editor action. Returns false when the action did not apply (so callers can fall through). */
export function runAction(editor: Editor, action: ActionId, env: ActionEnv): boolean {
  const playback = editor.playback;
  const state = editor.getState();
  const doc = state.doc;
  const tracks = currentScene(doc).tracks;
  const frame = frameDuration(doc.settings.fps);
  const time = playback.getState().currentTime;
  const refs = state.selection.elements;
  const exec = (command: Command): boolean => {
    const result = editor.tryExecute(command);
    if (!result.ok) env.onRejected?.(result.error);
    return result.ok;
  };

  switch (action) {
    case "toggle-play": playback.toggle(env.nowMs()); return true;
    case "stop-playback": playback.stop(); return true;
    case "seek-forward": playback.seekBySeconds(1, env.nowMs()); return true;
    case "seek-backward": playback.seekBySeconds(-1, env.nowMs()); return true;
    case "jump-forward": playback.seekBySeconds(5, env.nowMs()); return true;
    case "jump-backward": playback.seekBySeconds(-5, env.nowMs()); return true;
    case "frame-step-forward": playback.seek(time + frame, env.nowMs()); return true;
    case "frame-step-backward": playback.seek(time - frame, env.nowMs()); return true;
    case "goto-start": playback.seek(mediaTime(0), env.nowMs()); return true;
    case "goto-end": playback.seek(editor.duration(), env.nowMs()); return true;
    case "split":
    case "split-left":
    case "split-right": {
      const retainSide = action === "split" ? "both" : action === "split-left" ? "right" : "left";
      const targets = splitTargets(tracks, state.selection, time);
      if (targets.length === 0) return false;
      if (!exec(splitCommand({ refs: targets, splitTime: time, retainSide }))) return true;
      if (action === "split-left" && state.rippleEnabled) {
        const kept = editor.getState().selection.elements[0];
        const el = kept ? getElement(currentScene(editor.getState().doc).tracks, kept) : undefined;
        if (el) playback.seek(el.startTime, env.nowMs());
      }
      return true;
    }
    case "delete-selected":
      if (refs.length === 0) return false;
      exec(deleteElements(refs));
      return true;
    case "copy-selected": return editor.copySelection();
    case "paste-copied": {
      const items = editor.clipboard;
      if (!items || items.length === 0) return false;
      exec(pasteCommand({ items, time }));
      return true;
    }
    case "duplicate-selected":
      if (refs.length === 0) return false;
      exec(duplicateCommand(refs));
      return true;
    case "toggle-snapping": editor.setSnappingEnabled(!state.snappingEnabled); return true;
    case "toggle-ripple-editing": editor.setRippleEnabled(!state.rippleEnabled); return true;
    case "toggle-bookmark": exec(toggleBookmark(time)); return true;
    case "toggle-source-audio": {
      const only = refs.length === 1 ? refs[0] : undefined;
      if (!only || !canToggleSourceAudio(getElement(tracks, only), doc.assets)) return false;
      exec(toggleSourceAudio(only));
      return true;
    }
    case "toggle-elements-muted-selected":
      if (refs.length === 0) return false;
      exec(toggleElementsMuted(refs));
      return true;
    case "toggle-elements-visibility-selected":
      if (refs.length === 0) return false;
      exec(toggleElementsHidden(refs));
      return true;
    case "select-all": editor.setSelection(selectAll(tracks)); return true;
    case "deselect-all":
    case "cancel-interaction":
      editor.discardPreview();
      editor.clearSelection();
      return true;
    case "undo": return editor.undo();
    case "redo": return editor.redo();
  }
}

