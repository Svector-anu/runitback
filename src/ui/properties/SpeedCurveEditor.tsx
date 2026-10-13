import { useRef, type KeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { updateElements } from "#/engine/commands";
import type { ElementRef, TimelineElement } from "#/engine/model";
import {
  SPEED_RAMP_PRESETS, SPEED_RAMP_PRESET_IDS, currentRampShape, presetShape, retimeForShape, type RampShapePoint, type SpeedRampPresetId,
} from "#/engine/timeline";
import { getServices } from "#/app/services";
import "../styles/vfx.css";
import { Button } from "../primitives/Button";
import { Section } from "../primitives/fields";
import { commitEdit, runEdit } from "../lib/edit";
import { trackPointerGesture } from "../lib/pointer-gesture";
import { addPoint, movePoint, removePoint, speedToY, yToSpeed } from "./speed-curve-logic";

const WIDTH = 240;
const HEIGHT = 112;
const PAD = 10;
const X = (position: number): number => PAD + position * (WIDTH - PAD * 2);
const Y = (speed: number): number => PAD + speedToY(speed) * (HEIGHT - PAD * 2);
const GRID_SPEEDS = [0.25, 0.5, 1, 2, 4];

type RampHost = Extract<TimelineElement, { type: "video" | "audio" }>;

/** Draggable speed curve (2-6 points) and preset chips for one video or audio clip. */
export function SpeedCurveEditor({ element, refValue }: { element: RampHost; refValue: ElementRef }): ReactNode {
  const { editor } = getServices();
  const svg = useRef<SVGSVGElement>(null);
  const shape = currentRampShape(element);
  const ramped = element.retime?.curve !== undefined;

  const retimeFor = (base: RampHost, next: ReadonlyArray<RampShapePoint>) => retimeForShape({ element: base, shape: next });
  const apply = (base: RampHost, next: ReadonlyArray<RampShapePoint>, mode: "preview" | "commit"): void => {
    const retime = retimeFor(base, next);
    if (!retime) return;
    const command = updateElements([{ ref: refValue, patch: { retime } }], "Edit speed curve");
    if (mode === "preview") editor.preview(command);
    else runEdit(editor, command);
  };

  const toShapeSpace = (event: { clientX: number; clientY: number }): { position: number; y: number } => {
    const box = svg.current?.getBoundingClientRect();
    if (!box) return { position: 0, y: 0 };
    const x = ((event.clientX - box.left) / box.width) * WIDTH;
    const y = ((event.clientY - box.top) / box.height) * HEIGHT;
    return { position: Math.min(1, Math.max(0, (x - PAD) / (WIDTH - PAD * 2))), y: Math.min(1, Math.max(0, (y - PAD) / (HEIGHT - PAD * 2))) };
  };

  const startDrag = (index: number) => (event: ReactPointerEvent<SVGCircleElement>): void => {
    event.preventDefault();
    event.stopPropagation();
    const base = element;
    const baseShape = shape;
    let latest = baseShape;
    trackPointerGesture({
      move: (e) => {
        const p = toShapeSpace(e);
        latest = movePoint(baseShape, index, { position: p.position, speed: yToSpeed(p.y) });
        apply(base, latest, "preview");
      },
      up: () => { if (latest !== baseShape) commitEdit(editor); else editor.discardPreview(); },
      cancel: () => editor.discardPreview(),
    });
  };

  const onKey = (index: number) => (event: KeyboardEvent<SVGCircleElement>): void => {
    const point = shape[index] as RampShapePoint;
    const step = event.shiftKey ? 0.1 : 0.02;
    let next: RampShapePoint[] | null = null;
    if (event.key === "ArrowUp") next = movePoint(shape, index, { position: point.position, speed: point.speed * (event.shiftKey ? 1.5 : 1.1) });
    else if (event.key === "ArrowDown") next = movePoint(shape, index, { position: point.position, speed: point.speed / (event.shiftKey ? 1.5 : 1.1) });
    else if (event.key === "ArrowLeft") next = movePoint(shape, index, { position: point.position - step, speed: point.speed });
    else if (event.key === "ArrowRight") next = movePoint(shape, index, { position: point.position + step, speed: point.speed });
    else if (event.key === "Delete" || event.key === "Backspace") {
      next = removePoint(shape, index);
      if (!next) { event.preventDefault(); event.stopPropagation(); return; }
    }
    if (!next) return;
    event.preventDefault();
    event.stopPropagation();
    apply(element, next, "commit");
  };

  const onAdd = (event: ReactPointerEvent<SVGSVGElement>): void => {
    if (event.detail < 2) return;
    const next = addPoint(shape, toShapeSpace(event).position);
    if (next) apply(element, next, "commit");
  };

  const choose = (id: SpeedRampPresetId): void => apply(element, presetShape(id), "commit");
  const reset = (): void => { runEdit(editor, updateElements([{ ref: refValue, patch: { retime: undefined } }], "Reset speed")); };
  const activePreset = SPEED_RAMP_PRESET_IDS.find((id) => {
    const candidate = SPEED_RAMP_PRESETS[id].shape;
    return ramped && candidate.length === shape.length && candidate.every(([position, speed], i) => Math.abs((shape[i] as RampShapePoint).position - position) < 0.01 && Math.abs((shape[i] as RampShapePoint).speed - speed) < 0.02);
  });

  const path = shape.map((p, i) => `${i === 0 ? "M" : "L"}${X(p.position).toFixed(1)} ${Y(p.speed).toFixed(1)}`).join(" ");

  return (
    <Section sectionKey={`${element.id}:speed-curve`} title="Speed ramp" collapsible>
      <div className="section__fields">
        <div className="chip-group" role="group" aria-label="Speed ramp presets">
          {SPEED_RAMP_PRESET_IDS.map((id) => (
            <button key={id} type="button" className="chip" aria-pressed={activePreset === id} title={SPEED_RAMP_PRESETS[id].description} onClick={() => choose(id)}>
              {SPEED_RAMP_PRESETS[id].name}
            </button>
          ))}
        </div>
        <svg ref={svg} className="speed-curve" viewBox={`0 0 ${WIDTH} ${HEIGHT}`} role="group" aria-label="Speed curve editor" data-testid="speed-curve" onPointerDown={onAdd}>
          {GRID_SPEEDS.map((speed) => (
            <g key={speed}>
              <line className="speed-curve__grid" x1={PAD} x2={WIDTH - PAD} y1={Y(speed)} y2={Y(speed)} data-unity={speed === 1} />
              <text className="speed-curve__label" x={PAD + 2} y={Y(speed) - 2}>{speed}x</text>
            </g>
          ))}
          <path className="speed-curve__line" d={path} fill="none" />
          {shape.map((p, i) => (
            <circle key={i} className="speed-curve__point" cx={X(p.position)} cy={Y(p.speed)} r={5} tabIndex={0} role="slider"
              aria-label={`Speed point ${i + 1}`} aria-valuemin={0.1} aria-valuemax={5} aria-valuenow={p.speed} aria-valuetext={`${p.speed.toFixed(2)}x at ${Math.round(p.position * 100)}% of the clip`}
              data-testid={`speed-point-${i}`} data-owns-keys="" onPointerDown={startDrag(i)} onKeyDown={onKey(i)}
              onDoubleClick={(e) => { e.stopPropagation(); const next = removePoint(shape, i); if (next) apply(element, next, "commit"); }} />
          ))}
        </svg>
        <p className="muted">Drag points to set the speed along the clip. Double-click the line to add a point (up to 6), double-click a point or press Delete to remove it. The ramp stays on the same moments of the footage when you trim or split.</p>
        <div className="row-between">
          <span className="muted">{ramped ? "Ramp active; the speed above is the average." : "Constant speed."}</span>
          <Button size="sm" variant="ghost" disabled={!ramped} onClick={reset}>Reset to 1x</Button>
        </div>
        <p className="muted">Audio follows the ramp in short constant-speed pieces; with Change pitch off each piece keeps its pitch, so very steep ramps can sound slightly steppy.</p>
      </div>
    </Section>
  );
}
