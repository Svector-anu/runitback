import { InvalidInputError, type ElementPatch } from "#/engine/model";
import { MAX_TIMELINE_TICKS } from "./invariants";
import { curveProblem } from "./speed-curve";

/** Rejects anything that is not an integer tick count in `[min, MAX_TIMELINE_TICKS]` (NaN, Infinity, 0.5, 1e300, ...). */
export function requireTick(name: string, value: unknown, min = 0): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new InvalidInputError(`${name} must be a whole number of ticks, got ${String(value)}`);
  }
  if (value < min) throw new InvalidInputError(`${name} must be at least ${min}, got ${value}`);
  if (value > MAX_TIMELINE_TICKS) throw new InvalidInputError(`${name} must be at most ${MAX_TIMELINE_TICKS} ticks (24 hours), got ${value}`);
  return value;
}

/** Param values travel into render code and JSON; a non-finite number would silently become null on save. */
export function requireFiniteParams(params: Readonly<Record<string, unknown>>): void {
  for (const [key, value] of Object.entries(params)) {
    if (typeof value === "number" && !Number.isFinite(value)) throw new InvalidInputError(`Parameter "${key}" must be a finite number, got ${value}`);
  }
}

/** Validates the numeric fields of an element patch before they reach the document. */
export function guardElementPatch(patch: ElementPatch): void {
  if (patch.params) requireFiniteParams(patch.params);
  if (patch.startTime !== undefined) requireTick("startTime", patch.startTime, -MAX_TIMELINE_TICKS);
  if (patch.duration !== undefined) requireTick("duration", patch.duration, 1);
  if (patch.trimStart !== undefined) requireTick("trimStart", patch.trimStart, 0);
  if (patch.trimEnd !== undefined) requireTick("trimEnd", patch.trimEnd, 0);
  if ("retime" in patch && patch.retime !== undefined) {
    const rate = patch.retime.rate;
    if (typeof rate !== "number" || !Number.isFinite(rate) || rate <= 0) {
      throw new InvalidInputError(`retime.rate must be a positive finite number, got ${String(rate)}`);
    }
    const curveIssue = patch.retime.curve === undefined ? null : curveProblem(patch.retime.curve);
    if (curveIssue) throw new InvalidInputError(`retime.curve: ${curveIssue}`);
  }
}
