import { useSyncExternalStore } from "react";
import { currentScene } from "#/engine/commands";
import type { EditorState } from "#/engine/editor";
import type { PlaybackState } from "#/engine/editor";
import type { SceneTracks } from "#/engine/model";
import type { SaveState } from "#/engine/persistence";
import { getServices } from "./services";

export function useEditorState<T>(selector: (state: EditorState) => T): T {
  const { editor } = getServices();
  return useSyncExternalStore(editor.subscribe, () => selector(editor.getState()));
}

export function usePlaybackState<T>(selector: (state: PlaybackState) => T): T {
  const { editor } = getServices();
  return useSyncExternalStore(editor.playback.subscribe, () => selector(editor.playback.getState()));
}

export function useSaveState(): SaveState {
  const { saveManager } = getServices();
  return useSyncExternalStore(saveManager.subscribe, saveManager.getState);
}

/** Tracks as the user currently sees them: an in-progress gesture's preview wins over the committed document. */
export function useTracks(): SceneTracks {
  return useEditorState((s) => currentScene(s.preview ?? s.doc).tracks);
}

export function useSettings() {
  return useEditorState((s) => (s.preview ?? s.doc).settings);
}

export function useAssets() {
  return useEditorState((s) => s.doc.assets);
}
