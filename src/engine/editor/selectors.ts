import { frameDuration, mediaTime, type FrameRate, type MediaTime } from "#/engine/time";
import type { Scene, SceneTracks } from "#/engine/model";
import { totalDuration } from "#/engine/timeline";
import { currentScene, type EditorDocument } from "#/engine/commands";

export function activeScene(doc: EditorDocument): Scene {
  return currentScene(doc);
}

export function activeTracks(doc: EditorDocument): SceneTracks {
  return currentScene(doc).tracks;
}

export function documentDuration(doc: EditorDocument): MediaTime {
  return totalDuration(activeTracks(doc));
}

/** Project length follows the main scene. */
export function projectDuration(doc: EditorDocument): MediaTime {
  const main = doc.scenes.find((s) => s.isMain) ?? doc.scenes[0];
  return main ? totalDuration(main.tracks) : mediaTime(0);
}

export function oneFrame(fps: FrameRate): MediaTime {
  return frameDuration(fps);
}
