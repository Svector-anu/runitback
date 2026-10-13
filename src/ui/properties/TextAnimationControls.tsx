import type { ReactNode } from "react";
import { currentScene } from "#/engine/commands";
import type { ElementRef, TextElement } from "#/engine/model";
import { TICKS_PER_SECOND } from "#/engine/time";
import { allElements } from "#/engine/timeline";
import { getServices } from "#/app/services";
import { Field } from "../primitives/fields";
import { SliderField } from "../primitives/SliderField";
import { runEdit } from "../lib/edit";
import { ANIMATION_CHOICES, ANIMATION_STEP_TICKS, MIN_ANIMATION_TICKS, sideState, textAnimationCommand, type AnimationChoice, type AnimationSide } from "./text-animation-logic";

const SIDE_LABEL: Record<AnimationSide, string> = { in: "In animation", out: "Out animation" };

function SidePicker({ element, refValue, side }: { element: TextElement; refValue: ElementRef; side: AnimationSide }): ReactNode {
  const { editor } = getServices();
  const state = sideState(element, side);
  const label = SIDE_LABEL[side];
  const tooShort = state.limit < 1;
  const committed = (): TextElement =>
    (allElements(currentScene(editor.getState().doc).tracks).find((l) => l.element.id === element.id)?.element as TextElement | undefined) ?? element;
  const choose = (choice: AnimationChoice): void => {
    runEdit(editor, textAnimationCommand({ ref: refValue, element: committed(), side, choice }));
  };
  const lowest = Math.min(MIN_ANIMATION_TICKS, state.limit);
  return (
    <Field label={label}>
      <div className="chip-group" role="group" aria-label={label}>
        {ANIMATION_CHOICES.map((c) => (
          <button key={c.id} type="button" className="chip" aria-pressed={state.choice === c.id} disabled={tooShort && c.id !== "none"} onClick={() => choose(c.id)}>
            {c.label}
          </button>
        ))}
      </div>
      {state.choice !== "none" ? (
        <SliderField
          label={`${label} length`} value={state.duration} min={lowest} max={Math.max(lowest + 1, state.limit)} step={ANIMATION_STEP_TICKS}
          defaultValue={Math.min(TICKS_PER_SECOND / 2, state.limit)} displayMultiplier={1 / TICKS_PER_SECOND} suffix="s" disabled={state.limit <= lowest}
          onPreview={(v) => { editor.preview(textAnimationCommand({ ref: refValue, element: committed(), side, choice: state.choice, duration: v })); }}
          onCommit={(v) => runEdit(editor, textAnimationCommand({ ref: refValue, element: committed(), side, choice: state.choice, duration: v }))}
        />
      ) : null}
      {tooShort ? <p className="muted">This clip is too short to animate.</p> : null}
    </Field>
  );
}

export function TextAnimationControls({ element, refValue }: { element: TextElement; refValue: ElementRef }): ReactNode {
  return (
    <div className="section__fields">
      <SidePicker element={element} refValue={refValue} side="in" />
      <SidePicker element={element} refValue={refValue} side="out" />
      <p className="muted">Animations are keyframes on opacity, position, scale or reveal; picking one replaces keyframes on those properties.</p>
    </div>
  );
}
