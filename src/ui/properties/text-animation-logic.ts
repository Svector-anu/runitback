import { maxTextAnimationDuration } from "#/engine/animation";
import { setTextAnimationCommand } from "#/engine/commands";
import { type ElementRef, type TextAnimationPreset, type TextAnimationSpec, type TextElement } from "#/engine/model";
import { TICKS_PER_SECOND, mediaTime } from "#/engine/time";
import type { Command } from "#/engine/commands";

export type AnimationSide = "in" | "out";
export type AnimationChoice = TextAnimationPreset | "none";

export const ANIMATION_CHOICES: ReadonlyArray<{ id: AnimationChoice; label: string }> = [
  { id: "none", label: "None" }, { id: "fade", label: "Fade" }, { id: "slide-up", label: "Slide up" },
  { id: "pop", label: "Pop" }, { id: "typewriter", label: "Typewriter" },
  { id: "blur-in", label: "Blur" }, { id: "stagger-words", label: "Word by word" }, { id: "type-caret", label: "Typing caret" }, { id: "count-up", label: "Count up" },
];

export const DEFAULT_ANIMATION_TICKS = TICKS_PER_SECOND / 2;
export const MIN_ANIMATION_TICKS = TICKS_PER_SECOND / 10;
export const ANIMATION_STEP_TICKS = TICKS_PER_SECOND / 20;

export interface SideState {
  choice: AnimationChoice;
  duration: number;
  /** Longest legal length for this clip (half of it); below one tick the clip cannot animate. */
  limit: number;
}

export function sideState(element: TextElement, side: AnimationSide): SideState {
  const spec = element.textAnimation?.[side];
  const limit = maxTextAnimationDuration(element.duration);
  return { choice: spec?.preset ?? "none", duration: spec?.duration ?? Math.min(DEFAULT_ANIMATION_TICKS, limit), limit };
}

function specFor(choice: AnimationChoice, duration: number, limit: number): TextAnimationSpec | null {
  if (choice === "none") return null;
  return { preset: choice, duration: mediaTime(Math.max(1, Math.min(Math.round(duration), limit))) };
}

/** Sets one side of the text animation, keeping the other side as is. */
export function textAnimationCommand(input: { ref: ElementRef; element: TextElement; side: AnimationSide; choice: AnimationChoice; duration?: number }): Command {
  const current = sideState(input.element, input.side);
  const spec = specFor(input.choice, input.duration ?? current.duration, current.limit);
  return setTextAnimationCommand({ ref: input.ref, [input.side]: spec });
}
