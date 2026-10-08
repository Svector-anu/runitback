import { TICKS_PER_SECOND, frameRateToFloat, roundMediaTime, type FrameRate } from "#/engine/time";
import { BASE_PIXELS_PER_SECOND, timeToPixels } from "./scale";

export const MIN_LABEL_SPACING_PX = 120;
export const MIN_TICK_SPACING_PX = 18;
const LABEL_FRAME_STEPS = [2, 3, 5, 10, 15];
const TICK_FRAME_STEPS = [1, 2, 3, 5, 10, 15];
const SECOND_STEPS = [1, 2, 3, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600];

export type RulerInterval = { unit: "frames" | "seconds"; step: number };

function findInterval(input: { zoom: number; fps: number; minSpacing: number; frameSteps: number[] }): RulerInterval {
  const perFrame = (BASE_PIXELS_PER_SECOND * input.zoom) / input.fps;
  const frames = input.frameSteps.find((n) => perFrame * n >= input.minSpacing);
  if (frames !== undefined) return { unit: "frames", step: frames };
  const seconds = SECOND_STEPS.find((s) => BASE_PIXELS_PER_SECOND * input.zoom * s >= input.minSpacing);
  return { unit: "seconds", step: seconds ?? 60 };
}

const toSecondsStep = (i: RulerInterval, fps: number): number => (i.unit === "frames" ? i.step / fps : i.step);

export function rulerIntervals(input: { zoom: number; fps: FrameRate }): { label: RulerInterval; tick: RulerInterval } {
  const fps = Math.max(1, Math.round(frameRateToFloat(input.fps)));
  const label = findInterval({ zoom: input.zoom, fps, minSpacing: MIN_LABEL_SPACING_PX, frameSteps: LABEL_FRAME_STEPS });
  let tick = findInterval({ zoom: input.zoom, fps, minSpacing: MIN_TICK_SPACING_PX, frameSteps: TICK_FRAME_STEPS });
  const ratio = toSecondsStep(label, fps) / toSecondsStep(tick, fps);
  if (Math.abs(ratio - Math.round(ratio)) > 1e-6) {
    const candidates: RulerInterval[] = [
      ...TICK_FRAME_STEPS.map((step) => ({ unit: "frames" as const, step })),
      ...SECOND_STEPS.map((step) => ({ unit: "seconds" as const, step })),
    ];
    const dividing = candidates.find((c) => {
      const r = toSecondsStep(label, fps) / toSecondsStep(c, fps);
      return Math.abs(r - Math.round(r)) < 1e-6 && BASE_PIXELS_PER_SECOND * input.zoom * toSecondsStep(c, fps) >= MIN_TICK_SPACING_PX;
    });
    tick = dividing ?? label;
  }
  return { label, tick };
}

export interface RulerTick {
  time: number;
  left: number;
  label: string | null;
}

export function formatRulerLabel(input: { time: number; fps: FrameRate }): string {
  const fps = Math.max(1, Math.round(frameRateToFloat(input.fps)));
  const totalSeconds = input.time / TICKS_PER_SECOND;
  const whole = Math.round(totalSeconds * 1e6) / 1e6;
  if (Number.isInteger(whole)) {
    const h = Math.floor(whole / 3600);
    const m = Math.floor((whole % 3600) / 60);
    const s = whole % 60;
    const ss = String(s).padStart(2, "0");
    return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${String(m).padStart(2, "0")}:${ss}`;
  }
  const frac = totalSeconds - Math.floor(totalSeconds);
  return `${Math.round(frac * fps)}f`;
}

/** Ticks and labels for the visible pixel range only (plus a buffer). */
export function buildRulerTicks(input: {
  zoom: number; fps: FrameRate; scrollLeft: number; viewportWidth: number; maxTime: number;
}): RulerTick[] {
  const { label, tick } = rulerIntervals({ zoom: input.zoom, fps: input.fps });
  const fpsInt = Math.max(1, Math.round(frameRateToFloat(input.fps)));
  const tickSeconds = toSecondsStep(tick, fpsInt);
  const labelSeconds = toSecondsStep(label, fpsInt);
  const buffer = Math.max(200, (input.scrollLeft + input.viewportWidth) * 0.15);
  const startPx = Math.max(0, input.scrollLeft - buffer);
  const endPx = input.scrollLeft + input.viewportWidth + buffer;
  const pxPerTick = BASE_PIXELS_PER_SECOND * input.zoom * tickSeconds;
  const first = Math.floor(startPx / pxPerTick);
  const last = Math.ceil(endPx / pxPerTick);
  const out: RulerTick[] = [];
  for (let i = first; i <= last; i++) {
    const time = roundMediaTime(i * tickSeconds * TICKS_PER_SECOND);
    if (time > input.maxTime) break;
    const ratio = (i * tickSeconds) / labelSeconds;
    const isLabel = Math.abs(ratio - Math.round(ratio)) < 1e-6;
    out.push({ time, left: timeToPixels(time, input.zoom), label: isLabel ? formatRulerLabel({ time, fps: input.fps }) : null });
  }
  return out;
}
