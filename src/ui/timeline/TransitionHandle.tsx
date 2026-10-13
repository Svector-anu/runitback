import { useRef, useState, type CSSProperties, type ReactNode } from "react";
import { setTransitionCommand } from "#/engine/commands";
import { TRANSITION_TYPES, type ElementRef, type TransitionType } from "#/engine/model";
import { TICKS_PER_SECOND } from "#/engine/time";
import { TRANSITION_NAMES } from "#/engine/timeline";
import { getServices } from "#/app/services";
import { Icon } from "../icons";
import { Button } from "../primitives/Button";
import { Popover } from "../primitives/Popover";
import { SliderField } from "../primitives/SliderField";
import { runEdit } from "../lib/edit";
import { defaultTransitionDuration, transitionRange, type Cut } from "./transitions";

const HANDLE_SIZE = 16;
const HANDLE_INSET = 20;

function BowTie(): ReactNode {
  return <svg viewBox="0 0 16 16" width="10" height="10" aria-hidden="true" fill="currentColor"><path d="M1 3l6 5-6 5zM15 3l-6 5 6 5z" /></svg>;
}

function Popup({ cut, trackId, open, anchor, onClose }: {
  cut: Cut; trackId: string; open: boolean; anchor: React.RefObject<HTMLButtonElement | null>; onClose: () => void;
}): ReactNode {
  const { editor } = getServices();
  const ref: ElementRef = { trackId, elementId: cut.incoming.id };
  const range = transitionRange(cut.max);
  const current = cut.transition;
  const set = (type: TransitionType, duration: number): ReturnType<typeof setTransitionCommand> =>
    setTransitionCommand({ ref, transition: { type, duration } });
  return (
    <Popover open={open} onClose={onClose} anchor={anchor} label={`Transition between ${cut.outgoing.name} and ${cut.incoming.name}`} className="popover--padded">
      <div className="transition-pop">
        <div className="transition-pop__title">Transition</div>
        <div className="transition-pop__types" role="group" aria-label="Transition type">
          {TRANSITION_TYPES.map((type) => (
            <button key={type} type="button" className="transition-type" data-type={type} aria-pressed={current?.type === type}
              onClick={() => runEdit(editor, set(type, current?.duration ?? defaultTransitionDuration(cut.max)))}>
              <span className="transition-type__glyph" aria-hidden="true" />
              <span>{TRANSITION_NAMES[type]}</span>
            </button>
          ))}
        </div>
        <div className="transition-pop__duration">
          <span className="label">Duration</span>
          <SliderField
            label="Transition duration" value={current?.duration ?? defaultTransitionDuration(cut.max)} min={range.min} max={Math.max(range.max, range.min + 1)} step={TICKS_PER_SECOND / 20}
            defaultValue={defaultTransitionDuration(cut.max)} displayMultiplier={1 / TICKS_PER_SECOND} suffix="s" disabled={!current || !range.usable}
            onPreview={(v) => { if (current) editor.preview(set(current.type, v)); }}
            onCommit={(v) => { if (current) runEdit(editor, set(current.type, v)); }}
          />
          <p className="muted">
            {!current ? "Pick a type first." : !range.usable ? "These clips are too short to lengthen the transition." : `Up to ${(cut.max / TICKS_PER_SECOND).toFixed(2)}s: half of the shorter clip.`}
          </p>
        </div>
        <Button variant="outline" size="sm" disabled={!current} onClick={() => { runEdit(editor, setTransitionCommand({ ref, transition: null })); onClose(); }}>
          <Icon name="trash" /> Remove transition
        </Button>
      </div>
    </Popover>
  );
}

/** Small control centred on a cut between two touching clips; opens the transition editor for that cut. */
export function TransitionHandle({ cut, trackId, trackTop, trackHeight, left }: {
  cut: Cut; trackId: string; trackTop: number; trackHeight: number; left: number;
}): ReactNode {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  const has = cut.transition !== null;
  const between = `${cut.outgoing.name} and ${cut.incoming.name}`;
  const label = cut.transition
    ? `Edit transition: ${TRANSITION_NAMES[cut.transition.type]}, ${(cut.transition.duration / TICKS_PER_SECOND).toFixed(2)} seconds, between ${between}`
    : `Add transition between ${between}`;
  const style: CSSProperties = { left: left - HANDLE_SIZE / 2, top: trackTop + trackHeight - HANDLE_INSET, width: HANDLE_SIZE, height: HANDLE_SIZE };
  return (
    <>
      <button
        ref={anchor} type="button" className="transition-handle" data-has-transition={has} data-open={open} style={style} aria-label={label} aria-haspopup="dialog" aria-expanded={open}
        title={has ? `${TRANSITION_NAMES[(cut.transition as { type: TransitionType }).type]}: click to edit` : "Add transition"}
        data-cut-time={cut.time} data-incoming-id={cut.incoming.id}
        onPointerDown={(e) => e.stopPropagation()} onClick={() => setOpen((o) => !o)}
      >
        {has ? <BowTie /> : <Icon name="plus" size={10} />}
      </button>
      <Popup cut={cut} trackId={trackId} open={open} anchor={anchor} onClose={() => setOpen(false)} />
    </>
  );
}
