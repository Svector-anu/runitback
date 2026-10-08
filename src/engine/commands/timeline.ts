import { mediaTime } from "#/engine/time";
import { isSameFrameRate } from "#/engine/time";
import {
  canElementHaveAudio, canTrackBeHidden, canTrackHaveAudio, createTrack, buildMediaElement, isVisualElement,
  EMPTY_SELECTION, type AudioElement, type ElementPatch, type ElementRef, type MediaAssetInfo, type SceneTracks,
  type SelectionState, type TimelineElement, type TrackType, type VideoElement,
} from "#/engine/model";
import { cloneAnimations } from "#/engine/animation";
import {
  allElements, applyElementUpdate, applyGroupMove, applyPlacement, copyElements, defaultInsertIndex, duplicateElements,
  elementsStrictlyAt, getElement, insertTrack, mapTracks, pasteElements, removeElements, removeTrack, resolveTrackPlacement,
  splitElements, trackTypeForElement, withElements, type ClipboardItem, type GroupMovePlan, type RetainSide,
} from "#/engine/timeline";
import { currentScene, mapCurrentTracks, type Command, type CommandResult, type EditorDocument } from "./types";

const selectionOf = (refs: ReadonlyArray<ElementRef>): SelectionState => ({ ...EMPTY_SELECTION, elements: [...refs] });

function result(doc: EditorDocument, selection?: SelectionState): CommandResult {
  return { doc, selection };
}

// ---- Tracks --------------------------------------------------------------------------------------------------

export function addTrack(input: { type: TrackType; index?: number; trackId?: string }): Command {
  return {
    label: "Add track",
    run(doc, ctx) {
      const id = input.trackId ?? ctx.newId();
      return result(mapCurrentTracks(doc, ctx, (tracks) =>
        insertTrack(tracks, createTrack(input.type, id), input.index ?? defaultInsertIndex(tracks, input.type))));
    },
  };
}

export function removeTrackCommand(trackId: string): Command {
  return {
    label: "Delete track",
    run: (doc, ctx) => result(mapCurrentTracks(doc, ctx, (tracks) => removeTrack(tracks, trackId))),
  };
}

function toggleTrackFlag(trackId: string, flag: "muted" | "hidden", label: string): Command {
  return {
    label,
    run: (doc, ctx) => result(mapCurrentTracks(doc, ctx, (tracks) =>
      mapTracks(tracks, (track) => {
        if (track.id !== trackId) return track;
        if (flag === "muted" && !canTrackHaveAudio(track)) return track;
        if (flag === "hidden" && !canTrackBeHidden(track)) return track;
        const current = (track as unknown as Record<string, boolean>)[flag] ?? false;
        return { ...track, [flag]: !current };
      }))),
  };
}
export const toggleTrackMuted = (trackId: string): Command => toggleTrackFlag(trackId, "muted", "Toggle track mute");
export const toggleTrackHidden = (trackId: string): Command => toggleTrackFlag(trackId, "hidden", "Toggle track visibility");

// ---- Insert --------------------------------------------------------------------------------------------------

export type InsertPlacement =
  | { mode: "explicit"; trackId: string }
  | { mode: "auto" }
  | { mode: "newTrack"; index: number; trackId?: string };

function isTimelineEmpty(tracks: SceneTracks): boolean {
  return allElements(tracks).length === 0;
}

/** First visual media on an empty timeline sets the canvas (and fps for video) so the project matches its footage. */
function adoptAssetFormat(doc: EditorDocument, asset: MediaAssetInfo | undefined): EditorDocument {
  if (!asset || asset.type === "audio" || !asset.width || !asset.height) return doc;
  const canvasSize = { width: asset.width, height: asset.height };
  const fps = asset.type === "video" && asset.fps ? asset.fps : doc.settings.fps;
  const sameCanvas = doc.settings.canvasSize.width === canvasSize.width && doc.settings.canvasSize.height === canvasSize.height;
  if (sameCanvas && isSameFrameRate(fps, doc.settings.fps)) return doc;
  return {
    ...doc,
    settings: {
      ...doc.settings, canvasSize, fps, canvasSizeMode: "custom",
      originalCanvasSize: doc.settings.originalCanvasSize ?? canvasSize,
    },
  };
}

export function insertElement(input: { element: TimelineElement; placement: InsertPlacement }): Command {
  return {
    label: `Add ${input.element.type}`,
    run(doc, ctx) {
      const scene = currentScene(doc);
      const element = input.element;
      const trackType = trackTypeForElement(element.type);
      const span = { start: element.startTime, duration: element.duration };
      let tracks = scene.tracks;
      let landedOn: string;
      let placed: TimelineElement = element;

      if (input.placement.mode === "newTrack") {
        const id = input.placement.trackId ?? ctx.newId();
        tracks = insertTrack(tracks, withElements(createTrack(trackType, id), [element]), input.placement.index);
        landedOn = id;
      } else {
        const placement = resolveTrackPlacement({
          tracks, trackType, spans: [span],
          strategy: input.placement.mode === "explicit" ? { kind: "explicit", trackId: input.placement.trackId } : { kind: "firstAvailable" },
        });
        if (!placement) throw new Error(`Cannot place ${element.type} on the requested track`);
        if (placement.kind === "existingTrack" && placement.adjustedStartTime !== undefined) {
          placed = { ...element, startTime: placement.adjustedStartTime } as TimelineElement;
        }
        const newTrackId = ctx.newId();
        tracks = applyPlacement({ tracks, placement, elements: [placed], newTrack: createTrack(trackType, newTrackId) });
        landedOn = placement.kind === "existingTrack" ? placement.trackId : newTrackId;
      }

      let next = mapCurrentTracks(doc, ctx, () => tracks);
      if (isTimelineEmpty(scene.tracks) && "mediaId" in element) {
        next = adoptAssetFormat(next, doc.assets.find((a) => a.id === element.mediaId));
      }
      return result(next, selectionOf([{ trackId: landedOn, elementId: placed.id }]));
    },
  };
}

export function insertMediaElement(input: { asset: MediaAssetInfo; elementId: string; startTime: number; placement: InsertPlacement }): Command {
  const element = buildMediaElement({ id: input.elementId, startTime: mediaTime(input.startTime), asset: input.asset });
  return insertElement({ element, placement: input.placement });
}

// ---- Update / delete -----------------------------------------------------------------------------------------

export interface ElementUpdate {
  ref: ElementRef;
  patch: ElementPatch;
}

export function updateElements(updates: ReadonlyArray<ElementUpdate>, label = "Edit"): Command {
  return {
    label,
    run: (doc, ctx) => result(mapCurrentTracks(doc, ctx, (tracks) =>
      updates.reduce((acc, u) => applyElementUpdate({ tracks: acc, ref: u.ref, patch: u.patch, newId: ctx.newId }), tracks))),
  };
}

export function deleteElements(refs: ReadonlyArray<ElementRef>): Command {
  return {
    label: refs.length > 1 ? "Delete elements" : "Delete element",
    run: (doc, ctx) => result(mapCurrentTracks(doc, ctx, (tracks) => removeElements(tracks, refs)), EMPTY_SELECTION),
  };
}

// ---- Split / move / duplicate / paste ------------------------------------------------------------------------

export function splitCommand(input: { refs: ReadonlyArray<ElementRef>; splitTime: number; retainSide?: RetainSide }): Command {
  return {
    label: "Split",
    run(doc, ctx) {
      const scene = currentScene(doc);
      const split = splitElements({ tracks: scene.tracks, refs: input.refs, splitTime: input.splitTime, retainSide: input.retainSide, newId: ctx.newId });
      if (!split.changed) return result(doc);
      return result(mapCurrentTracks(doc, ctx, () => split.tracks), selectionOf(split.selection));
    },
  };
}

/** Targets for a playhead split: the selection, or everything under the playhead when nothing is selected. */
export function splitTargets(tracks: SceneTracks, selection: SelectionState, time: number): ElementRef[] {
  if (selection.elements.length > 0) return selection.elements;
  return elementsStrictlyAt(tracks, time).map((l) => l.ref);
}

export function moveElements(plan: GroupMovePlan): Command {
  return {
    label: plan.moves.length > 1 ? "Move elements" : "Move element",
    run(doc, ctx) {
      const scene = currentScene(doc);
      const moved = applyGroupMove({ tracks: scene.tracks, plan });
      return result(mapCurrentTracks(doc, ctx, () => moved.tracks), selectionOf(moved.moved));
    },
  };
}

export function duplicateCommand(refs: ReadonlyArray<ElementRef>): Command {
  return {
    label: "Duplicate",
    run(doc, ctx) {
      const out = duplicateElements({ tracks: currentScene(doc).tracks, refs, newId: ctx.newId });
      return result(mapCurrentTracks(doc, ctx, () => out.tracks), selectionOf(out.selection));
    },
  };
}

export function pasteCommand(input: { items: ReadonlyArray<ClipboardItem>; time: number }): Command {
  return {
    label: "Paste",
    run(doc, ctx) {
      const out = pasteElements({ tracks: currentScene(doc).tracks, items: input.items, time: input.time, newId: ctx.newId });
      return result(mapCurrentTracks(doc, ctx, () => out.tracks), selectionOf(out.selection));
    },
  };
}

export { copyElements };

// ---- Visibility / mute / source audio ------------------------------------------------------------------------

/** If anything is visible hide all, otherwise show all. */
export function toggleElementsHidden(refs: ReadonlyArray<ElementRef>): Command {
  return {
    label: "Toggle visibility",
    run(doc, ctx) {
      const tracks = currentScene(doc).tracks;
      const targets = refs.map((r) => ({ ref: r, el: getElement(tracks, r) })).filter((t) => t.el && isVisualElement(t.el));
      const anyVisible = targets.some((t) => !(t.el as { hidden?: boolean }).hidden);
      return updateElements(targets.map((t) => ({ ref: t.ref, patch: { hidden: anyVisible } })), "Toggle visibility").run(doc, ctx);
    },
  };
}

/** If anything is audible mute all, otherwise unmute all. */
export function toggleElementsMuted(refs: ReadonlyArray<ElementRef>): Command {
  return {
    label: "Toggle mute",
    run(doc, ctx) {
      const tracks = currentScene(doc).tracks;
      const targets = refs.map((r) => ({ ref: r, el: getElement(tracks, r) })).filter((t) => t.el && canElementHaveAudio(t.el));
      const anyAudible = targets.some((t) => t.el?.params.muted !== true);
      return updateElements(targets.map((t) => ({ ref: t.ref, patch: { params: { muted: anyAudible } } })), "Toggle mute").run(doc, ctx);
    },
  };
}

export function canToggleSourceAudio(element: TimelineElement | undefined, assets: ReadonlyArray<MediaAssetInfo>): boolean {
  if (!element || element.type !== "video") return false;
  if (element.isSourceAudioEnabled === false) return true;
  const asset = assets.find((a) => a.id === element.mediaId);
  return !!asset && asset.hasAudio !== false;
}

/** Extract: copy the audio onto an audio track and silence the video's own. Recover: re-enable the video's audio. */
export function toggleSourceAudio(ref: ElementRef): Command {
  return {
    label: "Toggle source audio",
    run(doc, ctx) {
      const tracks = currentScene(doc).tracks;
      const element = getElement(tracks, ref);
      if (!element || element.type !== "video" || !canToggleSourceAudio(element, doc.assets)) return result(doc);
      if (element.isSourceAudioEnabled === false) {
        return updateElements([{ ref, patch: { isSourceAudioEnabled: true } }], "Recover audio").run(doc, ctx);
      }
      const video: VideoElement = element;
      const audio: AudioElement = {
        id: ctx.newId(), type: "audio", name: video.name, mediaId: video.mediaId,
        startTime: video.startTime, duration: video.duration, trimStart: video.trimStart, trimEnd: video.trimEnd,
        sourceDuration: video.sourceDuration,
        params: { volume: video.params.volume ?? 0, muted: video.params.muted ?? false },
        retime: video.retime ? { ...video.retime } : undefined,
        animations: pickVolumeAnimation(video),
      };
      if (!audio.retime) delete audio.retime;
      if (!audio.animations) delete audio.animations;
      const withFlag = updateElements([{ ref, patch: { isSourceAudioEnabled: false } }]).run(doc, ctx).doc;
      const placement = resolveTrackPlacement({
        tracks: currentScene(withFlag).tracks, trackType: "audio",
        spans: [{ start: audio.startTime, duration: audio.duration }], strategy: { kind: "firstAvailable" },
      });
      if (!placement) return result(doc);
      const newTrackId = ctx.newId();
      const next = mapCurrentTracks(withFlag, ctx, (t) => applyPlacement({ tracks: t, placement, elements: [audio], newTrack: createTrack("audio", newTrackId) }));
      return result(next);
    },
  };
}

function pickVolumeAnimation(video: VideoElement): AudioElement["animations"] {
  const volume = video.animations?.volume;
  if (!volume) return undefined;
  return cloneAnimations({ animations: { volume }, regenerateIds: undefined });
}
