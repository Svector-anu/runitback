import type {
  IdGenerator, MediaAssetInfo, ProjectSettings, Scene, SceneTracks, SelectionState,
} from "#/engine/model";

/** Everything a command may change and undo must restore. View state and metadata are outside. */
export interface EditorDocument {
  scenes: Scene[];
  currentSceneId: string;
  settings: ProjectSettings;
  assets: MediaAssetInfo[];
}

export interface CommandContext {
  newId: IdGenerator;
  now: () => string;
}

export interface CommandResult {
  doc: EditorDocument;
  selection?: SelectionState;
  /** Scene whose tracks were edited (defaults to the current scene); reactors and undo target it. */
  sceneId?: string;
}

export interface Command {
  readonly label: string;
  run(doc: EditorDocument, ctx: CommandContext): CommandResult;
}

export function currentScene(doc: EditorDocument): Scene {
  const scene = doc.scenes.find((s) => s.id === doc.currentSceneId);
  if (!scene) throw new Error(`Current scene ${doc.currentSceneId} is missing`);
  return scene;
}

export function sceneById(doc: EditorDocument, sceneId: string): Scene | undefined {
  return doc.scenes.find((s) => s.id === sceneId);
}

export function withSceneTracks(doc: EditorDocument, sceneId: string, tracks: SceneTracks, now: string): EditorDocument {
  return { ...doc, scenes: doc.scenes.map((s) => (s.id === sceneId ? { ...s, tracks, updatedAt: now } : s)) };
}

export function mapCurrentTracks(doc: EditorDocument, ctx: CommandContext, fn: (tracks: SceneTracks) => SceneTracks): EditorDocument {
  const scene = currentScene(doc);
  const tracks = fn(scene.tracks);
  return tracks === scene.tracks ? doc : withSceneTracks(doc, scene.id, tracks, ctx.now());
}
