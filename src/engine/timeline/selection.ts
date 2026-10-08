import type { ElementRef, SceneTracks, SelectionState, TimelineElement } from "#/engine/model";
import { EMPTY_SELECTION, orderedTracks } from "#/engine/model";
import { elementEnd } from "./tracks";
import { trackTops, type TrackLayout } from "./drop-target";

const same = (a: ElementRef, b: ElementRef): boolean => a.trackId === b.trackId && a.elementId === b.elementId;

export function isSelected(selection: SelectionState, ref: ElementRef): boolean {
  return selection.elements.some((r) => same(r, ref));
}

export function selectOnly(ref: ElementRef): SelectionState {
  return { ...EMPTY_SELECTION, elements: [ref] };
}

export function toggleSelection(selection: SelectionState, ref: ElementRef): SelectionState {
  const elements = isSelected(selection, ref) ? selection.elements.filter((r) => !same(r, ref)) : [...selection.elements, ref];
  return { ...EMPTY_SELECTION, elements };
}

export function selectAll(tracks: SceneTracks): SelectionState {
  const elements: ElementRef[] = [];
  for (const track of orderedTracks(tracks)) for (const e of track.elements) elements.push({ trackId: track.id, elementId: e.id });
  return { ...EMPTY_SELECTION, elements };
}

export interface Rect { left: number; right: number; top: number; bottom: number }

/** Elements whose rectangle intersects `box` (content coordinates). Touching counts. */
export function elementsInBox(input: {
  tracks: SceneTracks; box: Rect; layout: TrackLayout; timeToX: (time: number) => number;
}): ElementRef[] {
  const tops = trackTops(input.layout);
  const hits: ElementRef[] = [];
  orderedTracks(input.tracks).forEach((track, i) => {
    const top = tops[i] ?? 0;
    const bottom = top + (input.layout.heights[i] ?? 0);
    if (bottom < input.box.top || top > input.box.bottom) return;
    for (const e of track.elements as TimelineElement[]) {
      const left = input.timeToX(e.startTime);
      const right = input.timeToX(elementEnd(e));
      if (right >= input.box.left && left <= input.box.right) hits.push({ trackId: track.id, elementId: e.id });
    }
  });
  return hits;
}

/** Box select: additive merges and de-duplicates with the existing selection. */
export function applyBoxSelection(input: { current: SelectionState; hits: ReadonlyArray<ElementRef>; additive: boolean }): SelectionState {
  if (!input.additive) return { ...EMPTY_SELECTION, elements: [...input.hits] };
  const merged = [...input.current.elements];
  for (const hit of input.hits) if (!merged.some((r) => same(r, hit))) merged.push(hit);
  return { ...EMPTY_SELECTION, elements: merged };
}

/** Drops references to elements that no longer exist. */
export function pruneSelection(selection: SelectionState, tracks: SceneTracks): SelectionState {
  const live = new Set<string>();
  for (const track of orderedTracks(tracks)) for (const e of track.elements) live.add(`${track.id}/${e.id}`);
  const elements = selection.elements.filter((r) => live.has(`${r.trackId}/${r.elementId}`));
  const keyframes = selection.keyframes.filter((k) => live.has(`${k.trackId}/${k.elementId}`));
  if (elements.length === selection.elements.length && keyframes.length === selection.keyframes.length) return selection;
  return { elements, keyframes, keyframeAnchor: keyframes.length ? selection.keyframeAnchor : null };
}

/** Escape peels one selection layer at a time: keyframes, then elements. */
export function clearMostSpecific(selection: SelectionState): SelectionState {
  if (selection.keyframes.length > 0) return { ...selection, keyframes: [], keyframeAnchor: null };
  return EMPTY_SELECTION;
}
