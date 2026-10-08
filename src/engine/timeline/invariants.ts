import { TICKS_PER_SECOND } from "#/engine/time";
import { InvariantViolationError, orderedTracks, type Scene, type TimelineElement } from "#/engine/model";
import { effectiveRate } from "./retime";

/** No clip may start or end beyond 24 hours; keeps every tick count a safe integer and exports finite. */
export const MAX_TIMELINE_TICKS = 24 * 3600 * TICKS_PER_SECOND;

export interface InvariantDocument {
  scenes: ReadonlyArray<Scene>;
  currentSceneId: string;
}

const isTick = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value);

function hasNonFinite(params: Readonly<Record<string, unknown>> | undefined): boolean {
  return params !== undefined && Object.values(params).some((v) => typeof v === "number" && !Number.isFinite(v));
}

function elementViolations(element: TimelineElement): string[] {
  const out: string[] = [];
  const id = element.id;
  const decorated = element as { effects?: Array<{ params: Record<string, unknown> }>; masks?: Array<{ params: Record<string, unknown> }> };
  if (hasNonFinite(element.params) || decorated.effects?.some((e) => hasNonFinite(e.params)) || decorated.masks?.some((m) => hasNonFinite(m.params))) {
    out.push(`element ${id}: a parameter is not a finite number`);
  }
  const { startTime, duration, trimStart, trimEnd } = element;
  if (!isTick(startTime) || !isTick(duration) || !isTick(trimStart) || !isTick(trimEnd)) {
    out.push(`element ${id}: times must be integer ticks`);
    return out;
  }
  if (startTime < 0) out.push(`element ${id}: negative start ${startTime}`);
  if (duration < 1) out.push(`element ${id}: duration must be at least 1 tick, got ${duration}`);
  if (trimStart < 0 || trimEnd < 0) out.push(`element ${id}: negative trim`);
  if (startTime + duration > MAX_TIMELINE_TICKS) out.push(`element ${id}: ends beyond the 24 hour limit`);
  if ((element.type === "video" || element.type === "audio") && element.sourceDuration !== undefined) {
    const rate = effectiveRate(element.retime);
    if (!Number.isFinite(rate)) {
      out.push(`element ${id}: non-finite playback rate`);
    } else {
      const total = trimStart + duration * rate + trimEnd;
      if (Math.abs(total - element.sourceDuration) > 2 + rate) {
        out.push(`element ${id}: trim ${trimStart} + ${duration} x ${rate} + trim ${trimEnd} does not add up to the source length ${element.sourceDuration}`);
      }
    }
  }
  return out;
}

/** Every structural invariant violated inside one scene, as stable human-readable strings. */
export function sceneViolations(scene: Scene): string[] {
  const out: string[] = [];
  const elementIds = new Set<string>();
  const trackIds = new Set<string>();
  for (const track of orderedTracks(scene.tracks)) {
    if (trackIds.has(track.id)) out.push(`duplicate track id ${track.id}`);
    trackIds.add(track.id);
    const valid: TimelineElement[] = [];
    for (const element of track.elements as TimelineElement[]) {
      if (elementIds.has(element.id)) out.push(`duplicate element id ${element.id}`);
      elementIds.add(element.id);
      const problems = elementViolations(element);
      out.push(...problems);
      if (problems.length === 0) valid.push(element);
    }
    const sorted = [...valid].sort((a, b) => a.startTime - b.startTime);
    let reach: TimelineElement | undefined;
    for (const element of sorted) {
      if (reach && element.startTime < reach.startTime + reach.duration) {
        out.push(`overlap on track ${track.id}: ${reach.id} and ${element.id}`);
      }
      if (!reach || element.startTime + element.duration > reach.startTime + reach.duration) reach = element;
    }
  }
  return out;
}

export function documentViolations(doc: InvariantDocument): string[] {
  const out: string[] = [];
  if (!doc.scenes.some((s) => s.id === doc.currentSceneId)) out.push(`current scene ${doc.currentSceneId} does not exist`);
  const sceneIds = new Set<string>();
  for (const scene of doc.scenes) {
    if (sceneIds.has(scene.id)) out.push(`duplicate scene id ${scene.id}`);
    sceneIds.add(scene.id);
    out.push(...sceneViolations(scene));
  }
  return out;
}

/** Pure check for tests and dev tooling: throws `InvariantViolationError` listing every violation. */
export function assertDocumentInvariants(doc: InvariantDocument): void {
  const violations = documentViolations(doc);
  if (violations.length > 0) throw new InvariantViolationError(violations);
}

/**
 * Violations present in `after` that were not already present in `before`. Documents that were already damaged
 * (e.g. loaded from an old project) stay editable; an edit may never make things worse.
 */
export function introducedViolations(before: InvariantDocument, after: InvariantDocument): string[] {
  const out: string[] = [];
  const beforeScenes = new Map(before.scenes.map((s) => [s.id, s]));
  if (!after.scenes.some((s) => s.id === after.currentSceneId)) out.push(`current scene ${after.currentSceneId} does not exist`);
  for (const scene of after.scenes) {
    const previous = beforeScenes.get(scene.id);
    if (previous === scene) continue;
    const known = new Set(previous ? sceneViolations(previous) : []);
    out.push(...sceneViolations(scene).filter((v) => !known.has(v)));
  }
  return out;
}

/** Throws `InvariantViolationError` when `after` introduced violations relative to `before`. */
export function assertNoNewViolations(input: { before: InvariantDocument; after: InvariantDocument; label?: string }): void {
  const added = introducedViolations(input.before, input.after);
  if (added.length > 0) throw new InvariantViolationError(added, input.label);
}
