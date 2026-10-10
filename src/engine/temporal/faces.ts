import { trackFaces, type FaceDetections } from "#/engine/face";
import { frameSpans } from "#/engine/visual";
import type { TemporalEvent } from "./types";

/**
 * Events for `tracks.face`: one per continuous appearance of a tracked face, labelled `face-<id>` (the id is stable
 * while the tracker can follow the person) with the mean detector confidence as score. A frame stands for the span
 * halfway to its neighbours, never across a scene cut.
 */
export function faceEvents(input: { detections: FaceDetections; cuts: ReadonlyArray<number> }): TemporalEvent[] {
  const { detections } = input;
  const spans = frameSpans({ times: detections.frames.map((f) => f.t), durationSeconds: detections.durationSeconds, cuts: input.cuts });
  const frames = trackFaces(detections);
  const runs = new Map<number, Array<{ first: number; last: number; scores: number[] }>>();
  frames.forEach((frame, i) => {
    for (const face of frame.faces) {
      const own = runs.get(face.id) ?? [];
      const current = own[own.length - 1];
      if (current && current.last === i - 1) {
        current.last = i;
        current.scores.push(face.score);
      } else {
        own.push({ first: i, last: i, scores: [face.score] });
      }
      runs.set(face.id, own);
    }
  });
  const events: TemporalEvent[] = [];
  for (const [id, own] of runs) {
    for (const run of own) {
      const start = spans[run.first]?.startSeconds;
      const end = spans[run.last]?.endSeconds;
      if (start === undefined || end === undefined || end <= start) continue;
      events.push({ startSeconds: start, endSeconds: end, label: `face-${id}`, score: run.scores.reduce((a, b) => a + b, 0) / run.scores.length });
    }
  }
  return events.sort((a, b) => a.startSeconds - b.startSeconds || a.endSeconds - b.endSeconds || (a.label ?? "").localeCompare(b.label ?? ""));
}
