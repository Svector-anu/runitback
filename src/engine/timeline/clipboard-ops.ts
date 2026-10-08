import { mediaTime } from "#/engine/time";
import { cloneAnimations } from "#/engine/animation";
import {
  type ElementRef, type IdGenerator, type SceneTracks, type TimelineElement, type TrackType,
} from "#/engine/model";
import { applyPlacement, enforceMainTrackStart, resolveTrackPlacement, trackTypeForElement } from "./placement";
import { createTrackOfType } from "./track-factory";
import { allElements, displayIndexOfTrack } from "./tracks";

export type ClipboardElement = Omit<TimelineElement, "id">;

export interface ClipboardItem {
  trackId: string;
  trackType: TrackType;
  element: ClipboardElement;
}

export interface EditResult {
  tracks: SceneTracks;
  selection: ElementRef[];
}

function cloneWithNewIds(input: { element: TimelineElement | (ClipboardElement & { id?: string }); newId: IdGenerator; suffix?: string; startTime?: number }): TimelineElement {
  const { element, newId } = input;
  const clone = { ...element, id: newId() } as TimelineElement;
  if (input.suffix) clone.name = `${element.name}${input.suffix}`;
  if (input.startTime !== undefined) clone.startTime = mediaTime(input.startTime);
  const animations = cloneAnimations({ animations: element.animations, regenerateIds: newId });
  delete clone.animations;
  if (animations) clone.animations = animations;
  return clone;
}

function groupBySourceTrack<T extends { trackId: string }>(items: ReadonlyArray<T>): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) groups.set(item.trackId, [...(groups.get(item.trackId) ?? []), item]);
  return groups;
}

/** Duplicates always land on brand-new tracks (one per source track) at the top of their zone. */
export function duplicateElements(input: { tracks: SceneTracks; refs: ReadonlyArray<ElementRef>; newId: IdGenerator }): EditResult {
  const located = allElements(input.tracks);
  const wanted = input.refs.flatMap((ref) => located.filter((l) => l.ref.trackId === ref.trackId && l.ref.elementId === ref.elementId));
  let tracks = input.tracks;
  const selection: ElementRef[] = [];
  const bySource = new Map<string, typeof wanted>();
  for (const loc of wanted) bySource.set(loc.ref.trackId, [...(bySource.get(loc.ref.trackId) ?? []), loc]);
  for (const group of bySource.values()) {
    const first = group[0];
    if (!first) continue;
    const clones = group.map((g) => cloneWithNewIds({ element: g.element, newId: input.newId, suffix: " (copy)" }));
    const type = first.track.type;
    const placement = resolveTrackPlacement({
      tracks, trackType: type,
      spans: clones.map((c) => ({ start: c.startTime, duration: c.duration })),
      strategy: { kind: "alwaysNew", position: "highest" },
    });
    if (!placement) continue;
    const newTrackId = input.newId();
    tracks = applyPlacement({ tracks, placement, elements: clones, newTrack: createTrackOfType(type, newTrackId) });
    for (const c of clones) selection.push({ trackId: newTrackId, elementId: c.id });
  }
  return { tracks, selection };
}

export function copyElements(input: { tracks: SceneTracks; refs: ReadonlyArray<ElementRef> }): ClipboardItem[] {
  const located = allElements(input.tracks);
  const items: ClipboardItem[] = [];
  for (const ref of input.refs) {
    const loc = located.find((l) => l.ref.trackId === ref.trackId && l.ref.elementId === ref.elementId);
    if (!loc) continue;
    const element: Record<string, unknown> = { ...loc.element };
    delete element.id;
    items.push({ trackId: loc.track.id, trackType: loc.track.type, element: element as ClipboardElement });
  }
  return items;
}

/** Paste at `time`, preserving relative offsets; each source-track group is placed above its source if it fits. */
export function pasteElements(input: { tracks: SceneTracks; items: ReadonlyArray<ClipboardItem>; time: number; newId: IdGenerator }): EditResult {
  if (input.items.length === 0) return { tracks: input.tracks, selection: [] };
  const minStart = Math.min(...input.items.map((i) => i.element.startTime));
  let tracks = input.tracks;
  const selection: ElementRef[] = [];

  for (const [sourceTrackId, group] of groupBySourceTrack(input.items)) {
    const first = group[0];
    if (!first) continue;
    let clones = group.map((item) => cloneWithNewIds({
      element: item.element, newId: input.newId, startTime: Math.max(0, input.time + (item.element.startTime - minStart)),
    }));
    const elementType = clones[0]?.type;
    if (!elementType) continue;
    const placement = resolveTrackPlacement({
      tracks, trackType: trackTypeForElement(elementType),
      spans: clones.map((c) => ({ start: c.startTime, duration: c.duration })),
      strategy: { kind: "aboveSource", sourceTrackIndex: displayIndexOfTrack(tracks, sourceTrackId) },
    });
    if (!placement) continue;
    if (placement.kind === "existingTrack" && placement.trackId === tracks.main.id) {
      const groupStart = Math.min(...clones.map((c) => c.startTime));
      const adjusted = enforceMainTrackStart({ tracks, trackId: placement.trackId, requestedStart: groupStart });
      const shift = adjusted - groupStart;
      if (shift !== 0) clones = clones.map((c) => ({ ...c, startTime: mediaTime(c.startTime + shift) }) as TimelineElement);
    }
    const newTrackId = input.newId();
    tracks = applyPlacement({ tracks, placement, elements: clones, newTrack: createTrackOfType(first.trackType, newTrackId) });
    const landedOn = placement.kind === "existingTrack" ? placement.trackId : newTrackId;
    for (const c of clones) selection.push({ trackId: landedOn, elementId: c.id });
  }
  return { tracks, selection };
}
