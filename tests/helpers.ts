import { mediaTime, mediaTimeFromSeconds, type MediaTime } from "#/engine/time";
import {
  buildMediaElement, buildTextElement, createEmptyTracks, createTrack, sequentialIds,
  type AudioElement, type AudioTrack, type ImageElement, type MediaAssetInfo, type OverlayTrack, type SceneTracks,
  type TextElement, type TimelineElement, type TimelineTrack, type VideoElement,
} from "#/engine/model";
import { withElements } from "#/engine/timeline/tracks";

export const sec = (s: number): MediaTime => mediaTimeFromSeconds(s);
export const ids = sequentialIds("t");

export const videoAsset = (id = "v1", seconds = 10): MediaAssetInfo => ({
  id, name: `${id}.mp4`, type: "video", size: 1, lastModified: 0, width: 1920, height: 1080,
  duration: sec(seconds), hasAudio: true,
});

export function video(id: string, start: number, seconds: number, extra: Partial<VideoElement> = {}): VideoElement {
  const el = buildMediaElement({ id, startTime: sec(start), asset: videoAsset(`asset-${id}`, seconds) }) as VideoElement;
  return { ...el, ...extra };
}
export function image(id: string, start: number, seconds = 5): ImageElement {
  const el = buildMediaElement({ id, startTime: sec(start), asset: { id: `asset-${id}`, name: id, type: "image", size: 1, lastModified: 0 } }) as ImageElement;
  return { ...el, duration: sec(seconds) };
}
export function audio(id: string, start: number, seconds: number): AudioElement {
  return buildMediaElement({ id, startTime: sec(start), asset: { id: `asset-${id}`, name: id, type: "audio", size: 1, lastModified: 0, duration: sec(seconds) } }) as AudioElement;
}
export function text(id: string, start: number, seconds = 5): TextElement {
  return { ...buildTextElement({ id, startTime: sec(start) }), duration: sec(seconds) };
}

export function tracksWith(layout: { main?: TimelineElement[]; overlay?: Array<{ id: string; type?: OverlayTrack["type"]; elements: TimelineElement[] }>; audio?: Array<{ id: string; elements: TimelineElement[] }> }): SceneTracks {
  const base = createEmptyTracks(ids);
  const main = withElements({ ...base.main, id: "main" }, layout.main ?? []);
  const overlay = (layout.overlay ?? []).map((o) => withElements(createTrack(o.type ?? "video", o.id) as OverlayTrack, o.elements));
  const audioTracks = (layout.audio ?? []).map((a) => withElements(createTrack("audio", a.id) as AudioTrack, a.elements));
  return { overlay, main, audio: audioTracks };
}

export function mustTrack(tracks: SceneTracks, id: string): TimelineTrack {
  const found = [...tracks.overlay, tracks.main, ...tracks.audio].find((t) => t.id === id);
  if (!found) throw new Error(`track ${id} not found`);
  return found;
}
export const zeroTime = mediaTime(0);

import { Editor } from "#/engine/editor";
import { createProject, type Project } from "#/engine/model";

export function makeEditor(options: { assets?: MediaAssetInfo[] } = {}): { editor: Editor; project: Project; clock: { now: number } } {
  const newId = sequentialIds("e");
  const clock = { now: 0 };
  const editor = new Editor({ newId, now: () => "2026-01-01T00:00:00.000Z" });
  const project = createProject({ id: "p1", name: "Test", ids: newId, now: "2026-01-01T00:00:00.000Z" });
  editor.load({ project, assets: options.assets ?? [] });
  return { editor, project, clock };
}
