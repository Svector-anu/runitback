import { mediaTime } from "#/engine/time";
import { createScene, InvalidInputError, type Bookmark, type MediaAssetInfo, type ProjectSettings, type Scene } from "#/engine/model";
import { gradientProblem } from "#/engine/render";
import { allElements, requireTick } from "#/engine/timeline";
import { isSaneCanvas, isSaneFrameRate } from "./limits";
import { currentScene, sceneById, type Command, type EditorDocument } from "./types";

export function updateSettings(patch: Partial<ProjectSettings>): Command {
  return {
    label: "Change project settings",
    run(doc) {
      if (patch.canvasSize && !isSaneCanvas(patch.canvasSize.width, patch.canvasSize.height)) {
        throw new InvalidInputError(`Canvas size ${patch.canvasSize.width}x${patch.canvasSize.height} is outside the supported range`);
      }
      if (patch.fps && !isSaneFrameRate(patch.fps)) throw new InvalidInputError("Frame rate must be between 1 and 240 fps");
      if (patch.background?.type === "gradient") {
        const problem = gradientProblem(patch.background);
        if (problem) throw new InvalidInputError(`Invalid gradient background: ${problem}`);
      }
      return { doc: { ...doc, settings: { ...doc.settings, ...patch } } };
    },
  };
}

// ---- Scenes --------------------------------------------------------------------------------------------------

export function createSceneCommand(input: { name: string; sceneId?: string }): Command {
  return {
    label: "Create scene",
    run(doc, ctx) {
      const scene = createScene({ id: input.sceneId ?? ctx.newId(), name: input.name, isMain: false, ids: ctx.newId, now: ctx.now() });
      return { doc: { ...doc, scenes: [...doc.scenes, scene], currentSceneId: scene.id }, sceneId: scene.id };
    },
  };
}

export function deleteSceneCommand(sceneId: string): Command {
  return {
    label: "Delete scene",
    run(doc) {
      const scene = sceneById(doc, sceneId);
      if (!scene) return { doc };
      if (scene.isMain) throw new InvalidInputError("Cannot delete main scene");
      const scenes = doc.scenes.filter((s) => s.id !== sceneId);
      const main = scenes.find((s) => s.isMain) ?? scenes[0];
      if (!main) return { doc };
      return { doc: { ...doc, scenes, currentSceneId: doc.currentSceneId === sceneId ? main.id : doc.currentSceneId }, sceneId: main.id };
    },
  };
}

export function renameSceneCommand(sceneId: string, name: string): Command {
  return {
    label: "Rename scene",
    run: (doc, ctx) => ({ doc: { ...doc, scenes: doc.scenes.map((s) => (s.id === sceneId ? { ...s, name, updatedAt: ctx.now() } : s)) }, sceneId }),
  };
}

// ---- Bookmarks (identity = frame-snapped time) ---------------------------------------------------------------

function editBookmarks(label: string, fn: (bookmarks: Bookmark[], scene: Scene) => Bookmark[]): Command {
  return {
    label,
    run(doc, ctx) {
      const scene = currentScene(doc);
      const bookmarks = fn(scene.bookmarks, scene).sort((a, b) => a.time - b.time);
      return { doc: { ...doc, scenes: doc.scenes.map((s) => (s.id === scene.id ? { ...s, bookmarks, updatedAt: ctx.now() } : s)) }, sceneId: scene.id };
    },
  };
}

export const toggleBookmark = (time: number): Command =>
  editBookmarks("Toggle bookmark", (list) => {
    requireTick("time", time, 0);
    return list.some((b) => b.time === time) ? list.filter((b) => b.time !== time) : [...list, { time: mediaTime(time) }];
  });
export const removeBookmark = (time: number): Command => editBookmarks("Remove bookmark", (list) => list.filter((b) => b.time !== time));
export const updateBookmark = (time: number, updates: Partial<Omit<Bookmark, "time">>): Command =>
  editBookmarks("Edit bookmark", (list) => list.map((b) => (b.time === time ? { ...b, ...updates } : b)));
export const moveBookmark = (from: number, to: number): Command =>
  editBookmarks("Move bookmark", (list) => {
    requireTick("to", to, 0);
    return list.some((b) => b.time === to) && from !== to ? list : list.map((b) => (b.time === from ? { ...b, time: mediaTime(to) } : b));
  });

// ---- Media assets --------------------------------------------------------------------------------------------

/** Registering an asset is not undoable: the bytes are already stored. */
export function withAsset(doc: EditorDocument, asset: MediaAssetInfo): EditorDocument {
  return { ...doc, assets: [...doc.assets.filter((a) => a.id !== asset.id), asset] };
}

/** The document with `assets` as its asset list; the same object when nothing differs, so identity checks hold. */
export function withAssetList(doc: EditorDocument, assets: MediaAssetInfo[]): EditorDocument {
  const same = assets.length === doc.assets.length && assets.every((a, i) => a === doc.assets[i]);
  return same ? doc : { ...doc, assets };
}

/** Removes assets and every clip that uses them as one undoable step; stored bytes outlive the step for undo. */
export function removeAssetsCommand(assetIds: ReadonlyArray<string>): Command {
  const doomed = new Set(assetIds);
  return {
    label: assetIds.length > 1 ? "Remove media" : "Remove media item",
    run(doc, ctx) {
      const scenes = doc.scenes.map((scene) => {
        const refs = allElements(scene.tracks).filter((l) => "mediaId" in l.element && doomed.has(l.element.mediaId)).map((l) => l.ref);
        if (refs.length === 0) return scene;
        const remaining = new Set(refs.map((r) => `${r.trackId}/${r.elementId}`));
        const prune = <T extends { id: string; elements: unknown[] }>(t: T): T =>
          ({ ...t, elements: (t.elements as Array<{ id: string }>).filter((e) => !remaining.has(`${t.id}/${e.id}`)) }) as T;
        const tracks = { overlay: scene.tracks.overlay.map(prune), main: prune(scene.tracks.main), audio: scene.tracks.audio.map(prune) };
        return { ...scene, tracks, updatedAt: ctx.now() };
      });
      return { doc: { ...doc, scenes, assets: doc.assets.filter((a) => !doomed.has(a.id)) } };
    },
  };
}

