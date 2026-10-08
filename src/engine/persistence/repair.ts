import { mediaTime, type FrameRate } from "#/engine/time";
import {
  clampElementParams, randomId, TRACK_TYPE_FOR_ELEMENT, type IdGenerator, type Project, type Scene, type SceneTracks,
  type TimelineElement, type TimelineTrack, type TrackType,
} from "#/engine/model";
import { isSaneCanvas, isSaneFrameRate } from "#/engine/commands/limits";
import { MAX_TIMELINE_TICKS } from "#/engine/timeline/invariants";

type Raw = Record<string, unknown>;

export interface RepairResult {
  project: Project;
  /** One human-readable line per repaired problem. Empty when the project was already sound. */
  repairs: string[];
}

const DEFAULT_FPS: FrameRate = { numerator: 30, denominator: 1 };
const DEFAULT_CANVAS = { width: 1920, height: 1080 };
const MEDIA_ELEMENTS = new Set(["video", "image", "audio"]);
const ELEMENT_TYPES = new Set(["video", "image", "text", "graphic", "effect", "audio"]);
const OVERLAY_TRACK_TYPES = new Set<string>(["video", "text", "graphic", "effect"]);

const isRaw = (value: unknown): value is Raw => typeof value === "object" && value !== null && !Array.isArray(value);
const isFiniteNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const isNonEmptyString = (value: unknown): value is string => typeof value === "string" && value !== "";

class Notes {
  readonly list: string[] = [];
  add(message: string): void { this.list.push(message); }
}

function cleanParams(raw: unknown, owner: string, notes: Notes): Raw {
  if (!isRaw(raw)) {
    notes.add(`${owner}: parameters were missing and were reset`);
    return {};
  }
  const out: Raw = {};
  for (const [key, value] of Object.entries(raw)) {
    if (value === null || value === undefined || (typeof value === "number" && !Number.isFinite(value))) {
      notes.add(`${owner}: dropped the invalid parameter "${key}"`);
    } else {
      out[key] = value;
    }
  }
  return out;
}

function cleanDecorations(raw: unknown, owner: string, kind: "effects" | "masks", notes: Notes): Raw[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) {
    notes.add(`${owner}: dropped malformed ${kind}`);
    return [];
  }
  const out: Raw[] = [];
  for (const item of raw) {
    if (!isRaw(item) || !isNonEmptyString(item.id) || !isNonEmptyString(item.type)) {
      notes.add(`${owner}: dropped an unreadable ${kind === "effects" ? "effect" : "mask"}`);
      continue;
    }
    out.push({ ...item, params: cleanParams(item.params, `${owner} ${kind === "effects" ? "effect" : "mask"} ${item.id}`, notes) });
  }
  return out;
}

function repairElement(raw: unknown, notes: Notes): TimelineElement | null {
  if (!isRaw(raw) || !isNonEmptyString(raw.id) || typeof raw.type !== "string" || !ELEMENT_TYPES.has(raw.type)) {
    notes.add("dropped an unreadable clip");
    return null;
  }
  const id = raw.id;
  const owner = `clip ${id}`;
  if (MEDIA_ELEMENTS.has(raw.type) && !isNonEmptyString(raw.mediaId)) { notes.add(`${owner}: dropped (no media reference)`); return null; }
  if (raw.type === "graphic" && !isNonEmptyString(raw.definitionId)) { notes.add(`${owner}: dropped (no graphic definition)`); return null; }
  if (raw.type === "effect" && !isNonEmptyString(raw.effectType)) { notes.add(`${owner}: dropped (no effect type)`); return null; }
  if (!isFiniteNumber(raw.duration)) { notes.add(`${owner}: dropped (no usable duration)`); return null; }

  const el: Raw = { ...raw };
  if (typeof el.name !== "string") el.name = id;
  let duration = Math.round(raw.duration);
  if (duration !== raw.duration) notes.add(`${owner}: rounded its duration to whole ticks`);
  if (duration < 1) { duration = 1; notes.add(`${owner}: duration raised to the minimum`); }
  if (duration > MAX_TIMELINE_TICKS) { duration = MAX_TIMELINE_TICKS; notes.add(`${owner}: duration limited to 24 hours`); }

  let start = 0;
  if (!isFiniteNumber(raw.startTime)) {
    notes.add(`${owner}: start time was missing and was set to 0`);
  } else {
    start = Math.round(raw.startTime);
    if (start < 0) { start = 0; notes.add(`${owner}: negative start moved to 0`); }
    else if (start !== raw.startTime) notes.add(`${owner}: rounded its start to whole ticks`);
  }
  if (start + duration > MAX_TIMELINE_TICKS) { start = MAX_TIMELINE_TICKS - duration; notes.add(`${owner}: moved to end within 24 hours`); }
  el.startTime = mediaTime(start);
  el.duration = mediaTime(duration);

  for (const key of ["trimStart", "trimEnd"] as const) {
    const value = raw[key];
    if (isFiniteNumber(value) && value >= 0) {
      el[key] = mediaTime(Math.round(value));
    } else {
      el[key] = mediaTime(0);
      notes.add(`${owner}: ${key} was invalid and was reset to 0`);
    }
  }
  if (el.sourceDuration !== undefined && !(isFiniteNumber(el.sourceDuration) && el.sourceDuration >= 0)) {
    delete el.sourceDuration;
    notes.add(`${owner}: dropped an invalid source length`);
  }
  if (isRaw(el.retime) && !(isFiniteNumber(el.retime.rate) && el.retime.rate > 0)) {
    delete el.retime;
    notes.add(`${owner}: dropped an invalid playback speed`);
  }
  el.params = cleanParams(raw.params, owner, notes);
  const effects = cleanDecorations(raw.effects, owner, "effects", notes);
  if (effects) el.effects = effects;
  const masks = cleanDecorations(raw.masks, owner, "masks", notes);
  if (masks) el.masks = masks;

  const typed = el as unknown as TimelineElement;
  const clamped = clampElementParams(typed);
  const before = JSON.stringify([typed.params, (typed as { effects?: unknown }).effects, (typed as { masks?: unknown }).masks]);
  const after = JSON.stringify([clamped.params, (clamped as { effects?: unknown }).effects, (clamped as { masks?: unknown }).masks]);
  if (before !== after) notes.add(`${owner}: parameters outside their allowed range were limited`);
  return clamped;
}

function fitsTrack(trackType: string, element: TimelineElement): boolean {
  return TRACK_TYPE_FOR_ELEMENT[element.type] === trackType;
}

/** Greedy lane assignment: each lane holds clips that do not overlap each other. */
function splitIntoLanes(elements: TimelineElement[]): { kept: TimelineElement[]; overflow: TimelineElement[][] } {
  const sorted = [...elements].sort((a, b) => a.startTime - b.startTime);
  const kept: TimelineElement[] = [];
  const overflow: TimelineElement[][] = [];
  let keptEnd = -Infinity;
  for (const element of sorted) {
    if (element.startTime >= keptEnd) {
      kept.push(element);
      keptEnd = element.startTime + element.duration;
      continue;
    }
    const lane = overflow.find((l) => {
      const last = l[l.length - 1] as TimelineElement;
      return last.startTime + last.duration <= element.startTime;
    });
    if (lane) lane.push(element);
    else overflow.push([element]);
  }
  return { kept, overflow };
}

function repairScene(raw: Raw, newId: IdGenerator, sceneIds: Set<string>, notes: Notes): Scene {
  let id = isNonEmptyString(raw.id) ? raw.id : newId();
  if (sceneIds.has(id)) { id = newId(); notes.add("gave a duplicated scene a new id"); }
  sceneIds.add(id);

  const rawTracks = isRaw(raw.tracks) ? raw.tracks : {};
  const trackIds = new Set<string>();
  const elementIds = new Set<string>();
  const freshId = (taken: Set<string>): string => {
    let candidate = newId();
    while (taken.has(candidate)) candidate = newId();
    return candidate;
  };

  const repairTrack = (rawTrack: unknown, expected: TrackType | "overlay"): { track: TimelineTrack; overflow: TimelineElement[][] } | null => {
    if (!isRaw(rawTrack) || typeof rawTrack.type !== "string") { notes.add("dropped an unreadable track"); return null; }
    const type = rawTrack.type;
    if (expected === "overlay" ? !OVERLAY_TRACK_TYPES.has(type) : type !== expected) { notes.add(`dropped a track of unexpected type "${type}"`); return null; }
    let trackId = isNonEmptyString(rawTrack.id) ? rawTrack.id : freshId(trackIds);
    if (trackIds.has(trackId)) { trackId = freshId(trackIds); notes.add(`gave a duplicated track a new id (${trackId})`); }
    trackIds.add(trackId);
    if (!Array.isArray(rawTrack.elements)) notes.add(`track ${trackId}: clip list was missing and was reset`);
    const elements: TimelineElement[] = [];
    for (const item of Array.isArray(rawTrack.elements) ? rawTrack.elements : []) {
      const element = repairElement(item, notes);
      if (!element) continue;
      if (!fitsTrack(type, element)) { notes.add(`clip ${element.id}: dropped (a ${element.type} clip cannot sit on a ${type} track)`); continue; }
      if (elementIds.has(element.id)) {
        const fresh = freshId(elementIds);
        notes.add(`clip ${element.id}: gave a duplicated clip id a new id (${fresh})`);
        elements.push({ ...element, id: fresh } as TimelineElement);
        elementIds.add(fresh);
      } else {
        elementIds.add(element.id);
        elements.push(element);
      }
    }
    const { kept, overflow } = splitIntoLanes(elements);
    for (const lane of overflow) for (const e of lane) notes.add(`clip ${e.id}: overlapped another clip and was moved to a new track`);
    const name = typeof rawTrack.name === "string" ? rawTrack.name : "Track";
    return { track: { ...rawTrack, id: trackId, name, type, elements: kept } as unknown as TimelineTrack, overflow };
  };

  const laneTracks = (overflow: TimelineElement[][], type: TrackType): TimelineTrack[] => overflow.map((elements) => {
    const id = freshId(trackIds);
    trackIds.add(id);
    const base = type === "audio" ? { muted: false } : type === "video" ? { muted: false, hidden: false } : { hidden: false };
    return { id, name: "Recovered track", type, elements, ...base } as unknown as TimelineTrack;
  });

  const overlay: SceneTracks["overlay"] = [];
  const mainRepair = repairTrack({ ...(isRaw(rawTracks.main) ? rawTracks.main : {}), type: "video" }, "video");
  const main = (mainRepair?.track ?? { id: newId(), name: "Main Track", type: "video", elements: [], muted: false, hidden: false }) as SceneTracks["main"];
  for (const item of Array.isArray(rawTracks.overlay) ? rawTracks.overlay : []) {
    const repaired = repairTrack(item, "overlay");
    if (!repaired) continue;
    overlay.push(repaired.track as SceneTracks["overlay"][number]);
    overlay.push(...(laneTracks(repaired.overflow, repaired.track.type as TrackType) as SceneTracks["overlay"]));
  }
  if (mainRepair) overlay.push(...(laneTracks(mainRepair.overflow, "video") as SceneTracks["overlay"]));
  const audio: SceneTracks["audio"] = [];
  for (const item of Array.isArray(rawTracks.audio) ? rawTracks.audio : []) {
    const repaired = repairTrack(item, "audio");
    if (!repaired) continue;
    audio.push(repaired.track as SceneTracks["audio"][number]);
    audio.push(...(laneTracks(repaired.overflow, "audio") as SceneTracks["audio"]));
  }

  const bookmarks = (Array.isArray(raw.bookmarks) ? raw.bookmarks : []).filter((b): b is Scene["bookmarks"][number] => {
    const ok = isRaw(b) && isFiniteNumber(b.time);
    if (!ok) notes.add("dropped an unreadable bookmark");
    return ok;
  });
  return {
    id, name: typeof raw.name === "string" ? raw.name : "Scene", isMain: raw.isMain === true,
    tracks: { overlay, main, audio }, bookmarks,
    createdAt: typeof raw.createdAt === "string" ? raw.createdAt : "", updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : "",
  };
}

/**
 * Brings a stored project into a state the editor can safely open. Only repairs that lose nothing the user could
 * see are applied (clamp, round, regenerate ids, move overlapping clips to new tracks); clips that cannot be read at
 * all are dropped. Every repair is reported so the app can tell the user once.
 */
export function repairProject(project: Project, newId: IdGenerator = randomId): RepairResult {
  const notes = new Notes();
  const sceneIds = new Set<string>();
  const scenes = (project.scenes as unknown[]).filter(isRaw).map((s) => repairScene(s, newId, sceneIds, notes));

  const rawSettings = project.settings as unknown as Raw;
  const fps = rawSettings.fps as FrameRate;
  const canvas = rawSettings.canvasSize as { width: number; height: number };
  const settings = { ...project.settings };
  if (!isSaneFrameRate(fps)) { settings.fps = DEFAULT_FPS; notes.add("the frame rate was invalid and was reset to 30 fps"); }
  if (!isSaneCanvas(canvas.width, canvas.height)) { settings.canvasSize = DEFAULT_CANVAS; notes.add("the canvas size was invalid and was reset to 1920x1080"); }

  const assetIds = Array.isArray(project.assetIds) ? project.assetIds.filter((a) => typeof a === "string") : [];
  return { project: { ...project, scenes, settings, assetIds }, repairs: notes.list };
}
