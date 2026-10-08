import type { ElementAnimations, Project, Scene, TimelineElement, TimelineTrack } from "#/engine/model";
import { toSeconds } from "#/engine/time";
import { mergeRanges } from "./fixtures";
import type { Range, ResolvedFixture } from "./types";

export const FRAME_SECONDS = 1 / 30;

/** One timeline element in seconds, with the facts the checks need. */
export interface ClipView {
  id: string;
  type: TimelineElement["type"];
  trackId: string;
  trackType: TimelineTrack["type"];
  /** "main", "overlay" or "audio". */
  lane: "main" | "overlay" | "audio";
  name: string;
  start: number;
  end: number;
  duration: number;
  trimStart: number;
  trimEnd: number;
  /** Source seconds consumed per timeline second. */
  rate: number;
  mediaId?: string;
  sourceDuration?: number;
  /** True when the clip contributes sound to the mix. */
  audible: boolean;
  params: TimelineElement["params"];
  animations?: ElementAnimations;
}

export function sceneOf(project: Project): Scene {
  const scene = project.scenes.find((s) => s.id === project.currentSceneId) ?? project.scenes[0];
  if (!scene) throw new Error("Project has no scenes");
  return scene;
}

function lanes(project: Project): Array<{ track: TimelineTrack; lane: ClipView["lane"] }> {
  const { tracks } = sceneOf(project);
  return [
    ...tracks.overlay.map((track) => ({ track: track as TimelineTrack, lane: "overlay" as const })),
    { track: tracks.main as TimelineTrack, lane: "main" as const },
    ...tracks.audio.map((track) => ({ track: track as TimelineTrack, lane: "audio" as const })),
  ];
}

export function clipsOf(project: Project): ClipView[] {
  return lanes(project).flatMap(({ track, lane }) =>
    (track.elements as ReadonlyArray<TimelineElement>).map((element): ClipView => {
      const rate = "retime" in element ? (element.retime?.rate ?? 1) : 1;
      const muted = "muted" in track && track.muted;
      const carriesSound = element.type === "audio" || (element.type === "video" && element.isSourceAudioEnabled !== false);
      return {
        id: element.id,
        type: element.type,
        trackId: track.id,
        trackType: track.type,
        lane,
        name: element.name,
        start: toSeconds(element.startTime),
        end: toSeconds(element.startTime + element.duration),
        duration: toSeconds(element.duration),
        trimStart: toSeconds(element.trimStart),
        trimEnd: toSeconds(element.trimEnd),
        rate,
        ...("mediaId" in element ? { mediaId: element.mediaId } : {}),
        ...(element.sourceDuration !== undefined ? { sourceDuration: toSeconds(element.sourceDuration) } : {}),
        audible: carriesSound && !muted,
        params: element.params,
        ...(element.animations ? { animations: element.animations } : {}),
      };
    }));
}

export const byStart = (a: ClipView, b: ClipView): number => a.start - b.start || a.end - b.end;

export function timelineEnd(clips: ReadonlyArray<ClipView>): number {
  return clips.reduce((end, c) => Math.max(end, c.end), 0);
}

/** The source window a clip plays, in source seconds. */
export function sourceWindow(clip: ClipView): Range {
  return { start: clip.trimStart, end: clip.trimStart + clip.duration * clip.rate };
}

export function intersect(a: Range, b: Range): Range | null {
  const start = Math.max(a.start, b.start);
  const end = Math.min(a.end, b.end);
  return end > start ? { start, end } : null;
}

export const lengthOf = (ranges: ReadonlyArray<Range>): number => ranges.reduce((sum, r) => sum + (r.end - r.start), 0);

/** Parts of source `ranges` that a clip plays, expressed as timeline ranges. */
export function sourceRangesOnTimeline(clip: ClipView, ranges: ReadonlyArray<Range>): Range[] {
  const window = sourceWindow(clip);
  return ranges.flatMap((range) => {
    const hit = intersect(range, window);
    if (!hit) return [];
    return [{ start: clip.start + (hit.start - window.start) / clip.rate, end: clip.start + (hit.end - window.start) / clip.rate }];
  });
}

/** Timeline times of a source instant, one per clip that plays it. */
export function sourceTimesOnTimeline(clip: ClipView, times: ReadonlyArray<number>): number[] {
  const window = sourceWindow(clip);
  return times.filter((t) => t >= window.start - 1e-9 && t < window.end).map((t) => clip.start + (t - window.start) / clip.rate);
}

export function fixtureOf(fixtures: ReadonlyArray<ResolvedFixture>, mediaId: string | undefined): ResolvedFixture | undefined {
  return mediaId === undefined ? undefined : fixtures.find((f) => f.assetId === mediaId);
}

/** Time during which sound from a fixture is audible in the mix, as merged timeline ranges. */
export function audibleSoundRanges(input: { clips: ReadonlyArray<ClipView>; fixtures: ReadonlyArray<ResolvedFixture> }): Range[] {
  const loud = input.clips.filter((c) => c.audible).flatMap((clip) => {
    const fixture = fixtureOf(input.fixtures, clip.mediaId);
    return fixture ? sourceRangesOnTimeline(clip, fixture.truth.sound) : [];
  });
  return mergeRanges(loud);
}

/** Stretches of [0, end] with no audible sound. */
export function silentRuns(input: { audible: ReadonlyArray<Range>; end: number }): Range[] {
  const runs: Range[] = [];
  let cursor = 0;
  for (const range of [...input.audible, { start: input.end, end: input.end }]) {
    const start = Math.min(range.start, input.end);
    if (start - cursor > 1e-9) runs.push({ start: cursor, end: start });
    cursor = Math.max(cursor, range.end);
  }
  return runs;
}

/** Whitespace-insensitive, case-insensitive text for comparing captions that were re-wrapped. */
export const normalizeText = (text: string): string => text.replace(/\s+/g, " ").trim().toLowerCase();
