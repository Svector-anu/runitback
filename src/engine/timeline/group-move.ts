import { mediaTime, type MediaTime } from "#/engine/time";
import {
  InvalidInputError, TRACK_TYPE_FOR_ELEMENT, orderedTracks, type ElementRef, type IdGenerator, type SceneTracks, type TimelineElement,
  type TimelineTrack, type TrackType,
} from "#/engine/model";
import { defaultInsertIndex, highestInsertIndex, canPlaceSpans } from "./placement";
import { createTrackOfType } from "./track-factory";
import type { DropTarget } from "./drop-target";
import { allElements, insertTrack, intervalsOverlap, mapTracks, withElements } from "./tracks";

export interface MoveMember {
  ref: ElementRef;
  element: TimelineElement;
  trackType: TrackType;
  displayIndex: number;
  /** Start relative to the anchor's start. */
  timeOffset: number;
}

export interface PlannedMove {
  ref: ElementRef;
  toTrackId: string;
  startTime: MediaTime;
}

export interface NewTrackSpec {
  id: string;
  type: TrackType;
  displayIndex: number;
}

export interface GroupMovePlan {
  moves: PlannedMove[];
  createTracks: NewTrackSpec[];
}

export function buildMoveGroup(input: { tracks: SceneTracks; anchor: ElementRef; selection: ReadonlyArray<ElementRef> }): MoveMember[] | null {
  const located = allElements(input.tracks);
  const ordered = orderedTracks(input.tracks);
  const anchorLoc = located.find((l) => l.ref.trackId === input.anchor.trackId && l.ref.elementId === input.anchor.elementId);
  if (!anchorLoc) return null;
  const refs = [input.anchor, ...input.selection.filter((r) => !(r.trackId === input.anchor.trackId && r.elementId === input.anchor.elementId))];
  const members: MoveMember[] = [];
  for (const ref of refs) {
    const loc = located.find((l) => l.ref.trackId === ref.trackId && l.ref.elementId === ref.elementId);
    if (!loc) continue;
    members.push({
      ref, element: loc.element, trackType: loc.track.type,
      displayIndex: ordered.findIndex((t) => t.id === ref.trackId),
      timeOffset: loc.element.startTime - anchorLoc.element.startTime,
    });
  }
  return members;
}

function earliestStationaryMainStart(tracks: SceneTracks, moving: ReadonlySet<string>): number | null {
  const others = tracks.main.elements.filter((e) => !moving.has(e.id));
  return others.length === 0 ? null : Math.min(...others.map((e) => e.startTime));
}

/** Pick the lowest legal anchor start: no member negative, and main-track landers obey the start rule. */
function clampAnchorStart(input: { tracks: SceneTracks; members: ReadonlyArray<MoveMember>; assignments: ReadonlyArray<string>; anchorStart: number }): number {
  const minAnchor = Math.max(...input.members.map((m) => -m.timeOffset));
  let anchorStart = Math.max(input.anchorStart, minAnchor);
  const moving = new Set(input.members.map((m) => m.element.id));
  const earliest = earliestStationaryMainStart(input.tracks, moving);
  input.members.forEach((m, i) => {
    if (input.assignments[i] !== input.tracks.main.id) return;
    if (earliest === null || anchorStart + m.timeOffset <= earliest) anchorStart = Math.max(-m.timeOffset, minAnchor);
  });
  return anchorStart;
}

function canApply(input: { tracks: SceneTracks; members: ReadonlyArray<MoveMember>; assignments: ReadonlyArray<string>; anchorStart: number }): boolean {
  const moving = new Set(input.members.map((m) => m.element.id));
  const byTrack = new Map<string, Array<{ start: number; end: number }>>();
  input.members.forEach((m, i) => {
    const trackId = input.assignments[i] as string;
    const start = input.anchorStart + m.timeOffset;
    const list = byTrack.get(trackId) ?? [];
    list.push({ start, end: start + m.element.duration });
    byTrack.set(trackId, list);
  });
  for (const [trackId, spans] of byTrack) {
    for (let a = 0; a < spans.length; a++) {
      for (let b = a + 1; b < spans.length; b++) {
        if (intervalsOverlap(spans[a] as { start: number; end: number }, spans[b] as { start: number; end: number })) return false;
      }
    }
    const track = orderedTracks(input.tracks).find((t) => t.id === trackId);
    if (!track) continue;
    const stationary = { ...track, elements: (track.elements as TimelineElement[]).filter((e) => !moving.has(e.id)) } as TimelineTrack;
    if (!canPlaceSpans(stationary, spans.map((s) => ({ start: s.start, duration: s.end - s.start })))) return false;
  }
  return true;
}

interface SourceTrackGroup {
  trackId: string;
  trackType: TrackType;
  displayIndex: number;
}

/** Members that share a source track stay together on one destination track. */
function sourceGroups(members: ReadonlyArray<MoveMember>): SourceTrackGroup[] {
  const seen = new Map<string, SourceTrackGroup>();
  for (const m of members) {
    if (!seen.has(m.ref.trackId)) seen.set(m.ref.trackId, { trackId: m.ref.trackId, trackType: m.trackType, displayIndex: m.displayIndex });
  }
  return [...seen.values()].sort((a, b) => a.displayIndex - b.displayIndex);
}

function resolveOnExistingTracks(input: {
  tracks: SceneTracks; members: ReadonlyArray<MoveMember>; targetIndex: number; anchorStart: number;
}): GroupMovePlan | null {
  const ordered = orderedTracks(input.tracks);
  const anchor = input.members[0] as MoveMember;
  const target = ordered[input.targetIndex];
  if (!target || target.type !== anchor.trackType) return null;

  const groups = sourceGroups(input.members);
  const destination = new Map<string, string>([[anchor.ref.trackId, target.id]]);
  const used = new Set([target.id]);
  const anchorGroup = groups.findIndex((g) => g.trackId === anchor.ref.trackId);

  const scan = (group: SourceTrackGroup, from: number, step: 1 | -1): boolean => {
    let idx = from;
    while (idx >= 0 && idx < ordered.length && (ordered[idx]?.type !== group.trackType || used.has((ordered[idx] as TimelineTrack).id))) idx += step;
    const found = ordered[idx];
    if (!found) return false;
    destination.set(group.trackId, found.id);
    used.add(found.id);
    return true;
  };
  let cursor = input.targetIndex - 1;
  for (let g = anchorGroup - 1; g >= 0; g--) {
    if (!scan(groups[g] as SourceTrackGroup, cursor, -1)) return null;
    cursor = ordered.findIndex((t) => t.id === destination.get((groups[g] as SourceTrackGroup).trackId)) - 1;
  }
  cursor = input.targetIndex + 1;
  for (let g = anchorGroup + 1; g < groups.length; g++) {
    if (!scan(groups[g] as SourceTrackGroup, cursor, 1)) return null;
    cursor = ordered.findIndex((t) => t.id === destination.get((groups[g] as SourceTrackGroup).trackId)) + 1;
  }

  const assignments = input.members.map((m) => destination.get(m.ref.trackId) as string);
  const anchorStart = clampAnchorStart({ tracks: input.tracks, members: input.members, assignments, anchorStart: input.anchorStart });
  if (!canApply({ tracks: input.tracks, members: input.members, assignments, anchorStart })) return null;
  return {
    createTracks: [],
    moves: input.members.map((m, i) => ({ ref: m.ref, toTrackId: assignments[i] as string, startTime: mediaTime(anchorStart + m.timeOffset) })),
  };
}

function resolveOnNewTracks(input: {
  tracks: SceneTracks; members: ReadonlyArray<MoveMember>; insertIndex: number; anchorStart: number; newTrackIds: ReadonlyArray<string>;
}): GroupMovePlan | null {
  const { members } = input;
  const groups = sourceGroups(members);
  if (input.newTrackIds.length < groups.length) return null;
  const hasAudio = groups.some((g) => g.trackType === "audio");
  if (hasAudio && groups.some((g) => g.trackType !== "audio")) return null;

  const anchorOrder = groups.findIndex((g) => g.trackId === (members[0] as MoveMember).ref.trackId);
  const overlayCount = input.tracks.overlay.length;
  const blockStart = hasAudio
    ? Math.max(overlayCount + 1, input.insertIndex - anchorOrder)
    : Math.max(0, Math.min(input.insertIndex - anchorOrder, overlayCount));
  const destination = new Map<string, string>();
  const createTracks: NewTrackSpec[] = groups.map((g, order) => {
    const id = input.newTrackIds[order] as string;
    destination.set(g.trackId, id);
    return { id, type: g.trackType, displayIndex: blockStart + order };
  });
  const anchorStart = Math.max(input.anchorStart, ...members.map((m) => -m.timeOffset));
  return {
    createTracks,
    moves: members.map((m) => ({ ref: m.ref, toTrackId: destination.get(m.ref.trackId) as string, startTime: mediaTime(anchorStart + m.timeOffset) })),
  };
}

/**
 * Plan a group move. Falls back to fresh tracks when the existing-track attempt collides;
 * returns null when neither is legal (the drag reverts).
 */
export function resolveGroupMove(input: {
  tracks: SceneTracks; members: ReadonlyArray<MoveMember>; target: DropTarget; anchorStart: number; newTrackIds: ReadonlyArray<string>;
}): GroupMovePlan | null {
  if (input.members.length === 0) return null;
  if (!input.target.isNewTrack) {
    const onExisting = resolveOnExistingTracks({ tracks: input.tracks, members: input.members, targetIndex: input.target.trackIndex, anchorStart: input.anchorStart });
    if (onExisting) return onExisting;
  }
  const anchor = input.members[0] as MoveMember;
  const insertIndex = input.target.isNewTrack
    ? input.target.trackIndex
    : anchor.trackType === "audio" ? highestInsertIndex(input.tracks, "audio") : defaultInsertIndex(input.tracks, anchor.trackType);
  return resolveOnNewTracks({ tracks: input.tracks, members: input.members, insertIndex, anchorStart: input.anchorStart, newTrackIds: input.newTrackIds });
}

export function planChangesAnything(input: { tracks: SceneTracks; plan: GroupMovePlan }): boolean {
  if (input.plan.createTracks.length > 0) return true;
  const located = allElements(input.tracks);
  return input.plan.moves.some((move) => {
    const loc = located.find((l) => l.ref.trackId === move.ref.trackId && l.ref.elementId === move.ref.elementId);
    return !loc || loc.track.id !== move.toTrackId || loc.element.startTime !== move.startTime;
  });
}

/** Applies a plan: create tracks, detach moved elements, attach them at their new place. */
export function applyGroupMove(input: { tracks: SceneTracks; plan: GroupMovePlan }): { tracks: SceneTracks; moved: ElementRef[] } {
  let tracks = input.tracks;
  const creations = [...input.plan.createTracks].sort((a, b) => a.displayIndex - b.displayIndex);
  for (const spec of creations) tracks = insertTrack(tracks, createTrackOfType(spec.type, spec.id), spec.displayIndex);

  const located = allElements(tracks);
  const detached = new Map<string, TimelineElement>();
  for (const move of input.plan.moves) {
    const loc = located.find((l) => l.ref.trackId === move.ref.trackId && l.ref.elementId === move.ref.elementId);
    if (!loc) throw new InvalidInputError(`Cannot move missing element ${move.ref.elementId}`);
    const dest = orderedTracks(tracks).find((t) => t.id === move.toTrackId);
    if (!dest) throw new InvalidInputError(`Move target track ${move.toTrackId} does not exist`);
    if (TRACK_TYPE_FOR_ELEMENT[loc.element.type] !== dest.type) {
      throw new InvalidInputError(`Cannot place ${loc.element.type} on a ${dest.type} track`);
    }
    detached.set(loc.element.id, { ...loc.element, startTime: move.startTime } as TimelineElement);
  }
  tracks = mapTracks(tracks, (track) => withElements(track, (track.elements as TimelineElement[]).filter((e) => !detached.has(e.id))));
  for (const move of input.plan.moves) {
    const el = detached.get(move.ref.elementId) as TimelineElement;
    tracks = mapTracks(tracks, (track) => (track.id === move.toTrackId ? withElements(track, [...(track.elements as TimelineElement[]), el]) : track));
  }
  return { tracks, moved: input.plan.moves.map((m) => ({ trackId: m.toTrackId, elementId: m.ref.elementId })) };
}

export function mintTrackIds(count: number, newId: IdGenerator): string[] {
  return Array.from({ length: count }, () => newId());
}
