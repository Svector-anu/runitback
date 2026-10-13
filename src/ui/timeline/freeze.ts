import type { TimelineElement } from "#/engine/model";
import { TICKS_PER_SECOND } from "#/engine/time";
import { elementEnd } from "#/engine/timeline";

export const DEFAULT_FREEZE_TICKS = 2 * TICKS_PER_SECOND;

export type FreezeAvailability = { ok: true } | { ok: false; reason: string };

/** A freeze needs one video clip with the playhead strictly inside it (the engine rejects the very end). */
export function freezeAvailability(element: TimelineElement | undefined, playhead: number): FreezeAvailability {
  if (!element || element.type !== "video") return { ok: false, reason: "Select a video clip to freeze a frame" };
  if (playhead < element.startTime || playhead >= elementEnd(element)) return { ok: false, reason: "Move the playhead inside the clip to freeze that frame" };
  return { ok: true };
}
