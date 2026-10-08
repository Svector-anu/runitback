import { listKeyframes } from "#/engine/animation";
import { orderedTracks, type SceneTracks, type TimelineElement, type TimelineTrack, type TrackType } from "#/engine/model";
import type { TrackLayout } from "#/engine/timeline";

export const TRACK_HEIGHTS: Record<TrackType, number> = { video: 65, text: 25, audio: 50, graphic: 25, effect: 25 };
export const KEYFRAME_LANE_HEIGHT = 20;
export const TRACK_GAP = 6;
export const LABELS_WIDTH = 112;
export const RULER_HEIGHT = 22;
export const BOOKMARK_ROW_HEIGHT = 16;
export const CONTENT_TOP_PADDING = 2;
export const HEADER_HEIGHT = RULER_HEIGHT + BOOKMARK_ROW_HEIGHT;
export const DRAG_THRESHOLD_PX = 5;
export const THUMBNAIL_ASPECT = 16 / 9;

export interface TrackBox {
  track: TimelineTrack;
  index: number;
  top: number;
  baseHeight: number;
  height: number;
  /** Property paths shown as keyframe lanes under the clips of this track. */
  lanes: string[];
}

export interface TimelineGeometry {
  boxes: TrackBox[];
  totalHeight: number;
  layout: TrackLayout;
}

export function lanePaths(element: TimelineElement): string[] {
  return [...new Set(listKeyframes(element.animations).map((k) => k.path))];
}

export function computeGeometry(input: { tracks: SceneTracks; expanded: ReadonlySet<string> }): TimelineGeometry {
  const boxes: TrackBox[] = [];
  let y = CONTENT_TOP_PADDING;
  orderedTracks(input.tracks).forEach((track, index) => {
    const baseHeight = TRACK_HEIGHTS[track.type];
    const lanes: string[] = [];
    for (const element of track.elements as TimelineElement[]) {
      if (!input.expanded.has(element.id)) continue;
      for (const path of lanePaths(element)) if (!lanes.includes(path)) lanes.push(path);
    }
    const height = baseHeight + lanes.length * KEYFRAME_LANE_HEIGHT;
    boxes.push({ track, index, top: y, baseHeight, height, lanes });
    y += height + TRACK_GAP;
  });
  const heights = boxes.map((b) => b.height);
  return { boxes, totalHeight: y, layout: { heights, gap: TRACK_GAP } };
}

/** Human labels for animated property paths. */
export function pathLabel(path: string): string {
  const known: Record<string, string> = {
    "transform.positionX": "Position X", "transform.positionY": "Position Y", "transform.scaleX": "Scale X",
    "transform.scaleY": "Scale Y", "transform.rotate": "Rotation", opacity: "Opacity", volume: "Volume", color: "Color",
    "background.color": "BG color", "background.paddingX": "BG pad X", "background.paddingY": "BG pad Y",
    "background.offsetX": "BG offset X", "background.offsetY": "BG offset Y", "background.cornerRadius": "BG radius",
  };
  if (known[path]) return known[path];
  const effect = /^effects\.[^.]+\.params\.(.+)$/.exec(path);
  if (effect) return `Effect ${effect[1]}`;
  return path.replace(/^params\./, "");
}
