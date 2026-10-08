import { mediaTime } from "#/engine/time";
import { isSameFrameRate } from "#/engine/time";
import {
  canElementHaveAudio, canTrackBeHidden, clampElementParams, canTrackHaveAudio, createTrack, buildMediaElement, isVisualElement,
  EMPTY_SELECTION, InvalidInputError, type AudioElement, type ElementPatch, type ElementRef, type MediaAssetInfo, type SceneTracks,
  type SelectionState, type TimelineElement, type TrackType, type VideoElement,
} from "#/engine/model";
import { cloneAnimations } from "#/engine/animation";
import {
  allElements, applyElementUpdate, applyGroupMove, buildResizeMembers, computeGroupResize, elementEnd, applyPlacement, copyElements, defaultInsertIndex, duplicateElements,
  elementsStrictlyAt, getElement, requireTick, findTrack, insertTrack, mapTracks, pasteElements, removeElements, removeTrack, resolveTrackPlacement,
  splitElements, trackTypeForElement, withElements, type ClipboardItem, type GroupMovePlan, type RetainSide,
} from "#/engine/timeline";
import { isSaneCanvas, isSaneFrameRate } from "./limits";
import { currentScene, mapCurrentTracks, type Command, type CommandResult, type EditorDocument } from "./types";

const selectionOf = (refs: ReadonlyArray<ElementRef>): SelectionState => ({ ...EMPTY_SELECTION, elements: [...refs] });

function result(doc: EditorDocument, selection?: SelectionState): CommandResult {
  return { doc, selection };
}

// ---- Tracks --------------------------------------------------------------------------------------------------

function assertTrackIdFree(tracks: SceneTracks, id: string): void {
  if (findTrack(tracks, id)) throw new InvalidInputError(`A track with id "${id}" already exists`);
}

function assertElementInsertable(tracks: SceneTracks, element: TimelineElement, existingIds?: ReadonlySet<string>): void {
  if (typeof element.id !== "string" || element.id === "") throw new InvalidInputError("Element id must be a non-empty string");
  if (existingIds ? existingIds.has(element.id) : allElements(tracks).some((l) => l.element.id === element.id)) {
    throw new InvalidInputError(`An element with id "${element.id}" already exists in this scene`);
  }
  requireTick("startTime", element.startTime, 0);
  requireTick("duration", element.duration, 1);
  requireTick("trimStart", element.trimStart, 0);
  requireTick("trimEnd", element.trimEnd, 0);
}

export function addTrack(input: { type: TrackType; index?: number; trackId?: string }): Command {
  return {
    label: "Add track",
    run(doc, ctx) {
      const id = input.trackId ?? ctx.newId();
      assertTrackIdFree(currentScene(doc).tracks, id);
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
/** Sets mute/visibility to an absolute value (toggles are for UI buttons); flags a track cannot have are ignored. */
export function setTrackFlags(input: { trackId: string; muted?: boolean; hidden?: boolean }): Command {
  return {
    label: "Edit track",
    run: (doc, ctx) => result(mapCurrentTracks(doc, ctx, (tracks) =>
      mapTracks(tracks, (track) => {
        if (track.id !== input.trackId) return track;
        let next = track;
        if (input.muted !== undefined && canTrackHaveAudio(track)) next = { ...next, muted: input.muted } as typeof track;
        if (input.hidden !== undefined && canTrackBeHidden(track)) next = { ...next, hidden: input.hidden } as typeof track;
        return next;
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
  if (!isSaneCanvas(asset.width, asset.height)) return doc;
  const canvasSize = { width: asset.width, height: asset.height };
  const fps = asset.type === "video" && asset.fps && isSaneFrameRate(asset.fps) ? asset.fps : doc.settings.fps;
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

function describePlacementFailure(tracks: SceneTracks, element: TimelineElement, placement: InsertPlacement): string {
  if (placement.mode !== "explicit") return `Cannot place ${element.type} on the timeline`;
  const track = findTrack(tracks, placement.trackId);
  if (!track) return `No track with id "${placement.trackId}"`;
  if (track.type !== trackTypeForElement(element.type)) return `A ${element.type} cannot go on a ${track.type} track`;
  return `${element.type} ${element.id} would overlap another clip on track "${placement.trackId}"`;
}

export function insertElement(input: { element: TimelineElement; placement: InsertPlacement }): Command {
  return {
    label: `Add ${input.element.type}`,
    run(doc, ctx) {
      const scene = currentScene(doc);
      assertElementInsertable(scene.tracks, input.element);
      const element = clampElementParams(input.element);
      const trackType = trackTypeForElement(element.type);
      const span = { start: element.startTime, duration: element.duration };
      let tracks = scene.tracks;
      let landedOn: string;
      let placed: TimelineElement = element;

      if (input.placement.mode === "newTrack") {
        const id = input.placement.trackId ?? ctx.newId();
        assertTrackIdFree(tracks, id);
        tracks = insertTrack(tracks, withElements(createTrack(trackType, id), [element]), input.placement.index);
        landedOn = id;
      } else {
        const placement = resolveTrackPlacement({
          tracks, trackType, spans: [span],
          strategy: input.placement.mode === "explicit" ? { kind: "explicit", trackId: input.placement.trackId } : { kind: "firstAvailable" },
        });
        if (!placement) throw new InvalidInputError(describePlacementFailure(scene.tracks, element, input.placement));
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

/**
 * Inserts many elements of one track type onto NEW tracks, opening an extra lane whenever a clip would overlap
 * the ones already in the lanes (overlapping subtitle cues end up on separate text tracks). Existing tracks are
 * never touched. Returns the new track ids through the selection (every inserted element).
 */
export function insertElementsOnLanes(input: { elements: ReadonlyArray<TimelineElement>; index?: number; label?: string }): Command {
  return {
    label: input.label ?? "Add elements",
    run(doc, ctx) {
      const scene = currentScene(doc);
      const first = input.elements[0];
      if (!first) return result(doc);
      const trackType = trackTypeForElement(first.type);
      const seen = new Set<string>();
      const existingIds = new Set(allElements(scene.tracks).map((l) => l.element.id));
      for (const element of input.elements) {
        if (trackTypeForElement(element.type) !== trackType) throw new InvalidInputError("All elements must belong on the same kind of track");
        assertElementInsertable(scene.tracks, element, existingIds);
        if (seen.has(element.id)) throw new InvalidInputError(`Duplicate element id "${element.id}" in the batch`);
        seen.add(element.id);
      }
      const lanes: TimelineElement[][] = [];
      const ordered = input.elements.map((e) => clampElementParams(e)).sort((a, b) => a.startTime - b.startTime);
      for (const element of ordered) {
        const lane = lanes.find((l) => elementEnd(l[l.length - 1] as TimelineElement) <= element.startTime);
        if (lane) lane.push(element);
        else lanes.push([element]);
      }
      let tracks = scene.tracks;
      const base = input.index ?? defaultInsertIndex(tracks, trackType);
      const selection: ElementRef[] = [];
      lanes.forEach((elements, lane) => {
        const id = ctx.newId();
        assertTrackIdFree(tracks, id);
        tracks = insertTrack(tracks, withElements(createTrack(trackType, id), elements), base + lane);
        for (const element of elements) selection.push({ trackId: id, elementId: element.id });
      });
      return result(mapCurrentTracks(doc, ctx, () => tracks), selectionOf(selection));
    },
  };
}

export function insertMediaElement(input: { asset: MediaAssetInfo; elementId: string; startTime: number; placement: InsertPlacement }): Command {
  return {
    label: `Add ${input.asset.type}`,
    run(doc, ctx) {
      requireTick("startTime", input.startTime, 0);
      const element = buildMediaElement({ id: input.elementId, startTime: mediaTime(input.startTime), asset: input.asset });
      return insertElement({ element, placement: input.placement }).run(doc, ctx);
    },
  };
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

/**
 * Moves the left and/or right edge of one element to absolute timeline times through the shared resize rules
 * (source trim, neighbour and source-length limits, frame rounding). Limits clamp rather than fail.
 */
export function trimElementCommand(input: { ref: ElementRef; start?: number; end?: number }): Command {
  return {
    label: "Trim",
    run(doc, ctx) {
      if (input.start !== undefined) requireTick("start", input.start, 0);
      if (input.end !== undefined) requireTick("end", input.end, 1);
      const fps = doc.settings.fps;
      const resizeEdge = (tracks: SceneTracks, side: "left" | "right", target: number): SceneTracks => {
        const element = getElement(tracks, input.ref);
        if (!element) return tracks;
        const delta = side === "left" ? target - element.startTime : target - elementEnd(element);
        const members = buildResizeMembers({ tracks, refs: [input.ref] });
        const { patches } = computeGroupResize({ members, side, delta, fps });
        return patches.reduce((acc, p) => applyElementUpdate({ tracks: acc, ref: p.ref, patch: p.patch, newId: ctx.newId }), tracks);
      };
      return result(mapCurrentTracks(doc, ctx, (tracks) => {
        let next = tracks;
        if (input.start !== undefined) next = resizeEdge(next, "left", input.start);
        if (input.end !== undefined) next = resizeEdge(next, "right", input.end);
        return next;
      }));
    },
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
      requireTick("splitTime", input.splitTime, 0);
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
      requireTick("time", input.time, 0);
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
