import type { TimelineElement, TimelineTrack, Transition } from "#/engine/model";
import { TICKS_PER_SECOND } from "#/engine/time";
import { canHaveTransition, effectiveTransition, maxTransitionDuration, transitionPartner } from "#/engine/timeline";

export interface Cut {
  /** The clip the transition leads into; the command targets it. */
  incoming: TimelineElement;
  outgoing: TimelineElement;
  /** Timeline ticks of the cut. */
  time: number;
  /** Longest legal transition here, in ticks. */
  max: number;
  transition: Transition | null;
}

/** Every place two video/image clips on a track touch, in time order. */
export function findCuts(track: TimelineTrack): Cut[] {
  const elements = track.elements as TimelineElement[];
  const cuts: Cut[] = [];
  for (const incoming of elements) {
    if (!canHaveTransition(incoming)) continue;
    const outgoing = transitionPartner(elements, incoming);
    if (!outgoing) continue;
    cuts.push({ incoming, outgoing, time: incoming.startTime, max: maxTransitionDuration(outgoing, incoming), transition: effectiveTransition(elements, incoming) });
  }
  return cuts.sort((a, b) => a.time - b.time);
}

export const DEFAULT_TRANSITION_TICKS = TICKS_PER_SECOND;
export const MIN_TRANSITION_TICKS = TICKS_PER_SECOND / 10;

/** The length a new transition starts with: one second, or the longest the neighbours allow. */
export function defaultTransitionDuration(max: number): number {
  return Math.min(DEFAULT_TRANSITION_TICKS, max);
}

/** Slider bounds in ticks; `usable` is false when the clips are too short for anything above one tick. */
export function transitionRange(max: number): { min: number; max: number; usable: boolean } {
  const min = Math.min(MIN_TRANSITION_TICKS, max);
  return { min, max, usable: max > min };
}
