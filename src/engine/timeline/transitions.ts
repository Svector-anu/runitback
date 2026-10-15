import { mediaTime } from "#/engine/time";
import {
  TRANSITION_TYPES, type SceneTracks, type TimelineElement, type TimelineTrack, type Transition, type TransitionType,
} from "#/engine/model";
import { elementEnd } from "./tracks";

export const TRANSITION_NAMES: Record<TransitionType, string> = {
  dissolve: "Cross dissolve",
  "fade-black": "Fade through black",
  "slide-left": "Slide left",
  "slide-right": "Slide right",
  "wipe-left": "Wipe left",
  "wipe-right": "Wipe right",
  zoom: "Zoom",
  blur: "Blur dissolve",
  flash: "Flash",
  glitch: "Glitch",
};

type Transitionable = Extract<TimelineElement, { type: "video" | "image" }>;

export function isTransitionType(value: unknown): value is TransitionType {
  return typeof value === "string" && (TRANSITION_TYPES as readonly string[]).includes(value);
}

export function withoutTransition<T extends TimelineElement>(element: T): T {
  const copy = { ...element };
  delete (copy as { transition?: unknown }).transition;
  return copy;
}

export function canHaveTransition(element: TimelineElement): element is Transitionable {
  return element.type === "video" || element.type === "image";
}

/** Longest transition between two clips: half of the shorter one. */
export function maxTransitionDuration(previous: { duration: number }, next: { duration: number }): number {
  return Math.floor(Math.min(previous.duration, next.duration) / 2);
}

/** The clip a transition on `element` blends from: the one on the same track that ends exactly where `element` starts. */
export function transitionPartner(trackElements: ReadonlyArray<TimelineElement>, element: TimelineElement): Transitionable | null {
  for (const other of trackElements) {
    if (other.id !== element.id && canHaveTransition(other) && elementEnd(other) === element.startTime) return other;
  }
  return null;
}

/** The transition as it applies given its neighbour (duration clamped), or null when it cannot apply. */
export function effectiveTransition(trackElements: ReadonlyArray<TimelineElement>, element: TimelineElement): Transition | null {
  if (!canHaveTransition(element) || !element.transition) return null;
  const partner = transitionPartner(trackElements, element);
  if (!partner) return null;
  const duration = Math.min(Math.round(element.transition.duration), maxTransitionDuration(partner, element));
  return duration >= 1 ? { type: element.transition.type, duration: mediaTime(duration) } : null;
}

function reconcileTrack(track: TimelineTrack): TimelineTrack {
  const elements = track.elements as TimelineElement[];
  let changed = false;
  const next = elements.map((element) => {
    if (!canHaveTransition(element) || !element.transition) return element;
    const effective = effectiveTransition(elements, element);
    if (effective && effective.duration === element.transition.duration && effective.type === element.transition.type) return element;
    changed = true;
    return (effective ? { ...element, transition: effective } : withoutTransition(element)) as TimelineElement;
  });
  return changed ? ({ ...track, elements: next } as TimelineTrack) : track;
}

/**
 * Reactor: a transition only exists between two touching clips and never exceeds half the shorter of them.
 * Runs inside every command, so a move, trim, split or delete that breaks adjacency removes the transition in
 * the same undo step. Returns the same object when nothing needed fixing.
 */
export function reconcileTransitions(tracks: SceneTracks): SceneTracks {
  const main = reconcileTrack(tracks.main) as SceneTracks["main"];
  const overlay = tracks.overlay.map((t) => reconcileTrack(t) as SceneTracks["overlay"][number]);
  const audio = tracks.audio;
  const same = main === tracks.main && overlay.every((t, i) => t === tracks.overlay[i]);
  return same ? tracks : { overlay, main, audio };
}

/** Problems a stored or edited document has with its transitions, for the invariant checker. */
export function transitionViolations(track: TimelineTrack): string[] {
  const out: string[] = [];
  const elements = track.elements as TimelineElement[];
  for (const element of elements) {
    const transition = (element as { transition?: Transition }).transition;
    if (!transition) continue;
    if (!canHaveTransition(element)) { out.push(`element ${element.id}: only video and image clips can have a transition`); continue; }
    if (!isTransitionType(transition.type)) out.push(`element ${element.id}: unknown transition type ${String(transition.type)}`);
    const partner = transitionPartner(elements, element);
    if (!partner) out.push(`element ${element.id}: transition without a touching previous clip`);
    else if (!(transition.duration >= 1) || transition.duration > maxTransitionDuration(partner, element)) {
      out.push(`element ${element.id}: transition duration ${transition.duration} is outside 1..${maxTransitionDuration(partner, element)}`);
    }
  }
  return out;
}
