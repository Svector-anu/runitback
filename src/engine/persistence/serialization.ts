import { mediaTime } from "#/engine/time";
import { PROJECT_SCHEMA_VERSION, type Project } from "#/engine/model";
import { ProjectFormatError, type UnreadableProject } from "./types";
import { repairProject } from "./repair";

export interface ProjectMigration {
  from: number;
  to: number;
  run(project: Record<string, unknown>): Record<string, unknown>;
}

/** Migrations are additive: they add fields and never remove or rename persisted ones. */
export const PROJECT_MIGRATIONS: ReadonlyArray<ProjectMigration> = [
  /** v2 added the optional clip `transition`; nothing to rewrite, the field is simply absent on older projects. */
  { from: 1, to: 2, run: (project) => project },
  /** v3 added the `adjust` effect type: a new value of an existing field. */
  { from: 2, to: 3, run: (project) => project },
  /** v4 added text stroke/shadow/reveal params (absent means the default) and the optional `textAnimation` record. */
  { from: 3, to: 4, run: (project) => project },
  /** v5 added `crop.*` params (absent means 0) and `freezeAt` on image clips (absent means an ordinary image). */
  { from: 4, to: 5, run: (project) => project },
  /** v6 added the optional `retime.curve` (speed ramp) and the `chroma-key` / `remove-background` effect types: absent on older projects. */
  { from: 5, to: 6, run: (project) => project },
  /**
   * v7 added template effects, all absent on older projects: text `blur` / `wordReveal` / `caret` / `highlight*` / `count*` params and the
   * `blur-in` / `stagger-words` / `type-caret` text animations, the `gradient` canvas background, the `blur` / `flash` / `glitch` transitions,
   * the `transform.rotateX` / `rotateY` / `perspective` params, the `shadow` effect type and the `cursor` / `window-frame` / `card` graphics.
   */
  { from: 6, to: 7, run: (project) => project },
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function migrateProject(
  raw: Record<string, unknown>, migrations: ReadonlyArray<ProjectMigration> = PROJECT_MIGRATIONS, target = PROJECT_SCHEMA_VERSION,
): Record<string, unknown> {
  let current = raw;
  let version = typeof current.version === "number" ? current.version : 0;
  if (version > target) throw new ProjectFormatError(`Project was saved by a newer version (v${version})`, "newer-version");
  while (version < target) {
    const step = migrations.find((m) => m.from === version);
    if (!step) throw new ProjectFormatError(`No migration from project version ${version}`);
    current = { ...step.run(current), version: step.to };
    version = step.to;
  }
  return current;
}

function requireRecord(value: unknown, what: string): Record<string, unknown> {
  if (!isRecord(value)) throw new ProjectFormatError(`Invalid project: ${what} is missing`);
  return value;
}

function requireArray(value: unknown, what: string): unknown[] {
  if (!Array.isArray(value)) throw new ProjectFormatError(`Invalid project: ${what} must be a list`);
  return value;
}

/** Structural validation of a stored project; element contents are trusted once the skeleton is sound. */
export function validateProject(raw: unknown): Project {
  const project = requireRecord(raw, "project");
  const metadata = requireRecord(project.metadata, "metadata");
  if (typeof metadata.id !== "string" || typeof metadata.name !== "string") throw new ProjectFormatError("Invalid project: metadata id/name");
  const scenes = requireArray(project.scenes, "scenes");
  if (scenes.length === 0) throw new ProjectFormatError("Invalid project: no scenes");
  for (const scene of scenes) {
    const s = requireRecord(scene, "scene");
    const tracks = requireRecord(s.tracks, "scene tracks");
    requireRecord(tracks.main, "main track");
    requireArray(tracks.overlay, "overlay tracks");
    requireArray(tracks.audio, "audio tracks");
    requireArray(s.bookmarks ?? [], "bookmarks");
  }
  const settings = requireRecord(project.settings, "settings");
  requireRecord(settings.fps, "fps");
  requireRecord(settings.canvasSize, "canvas size");
  if (typeof project.currentSceneId !== "string") throw new ProjectFormatError("Invalid project: currentSceneId");
  return project as unknown as Project;
}

export function serializeProject(project: Project): string {
  const stored: Project = { ...project };
  delete stored.repairNotes;
  return JSON.stringify(stored);
}

/**
 * Parse, migrate, validate, and repair. A project that is already damaged on disk must still open, so anything
 * safely repairable (negative starts, NaN params, duplicate ids, overlapping clips, ...) is fixed here and listed
 * in `repairNotes`; only a project whose skeleton cannot be read throws `ProjectFormatError`.
 */
export function deserializeProject(json: string | unknown): Project {
  const raw = typeof json === "string" ? (JSON.parse(json) as unknown) : json;
  const migrated = migrateProject(requireRecord(raw, "project"));
  const project = validateProject(migrated);
  const currentSceneId = project.scenes.some((s) => s.id === project.currentSceneId)
    ? project.currentSceneId
    : (project.scenes.find((s) => s.isMain) ?? project.scenes[0])!.id;
  const view = project.timelineViewState ?? { zoomLevel: 1, scrollLeft: 0, playheadTime: mediaTime(0) };
  const playhead = Number.isFinite(view.playheadTime) ? Math.round(view.playheadTime) : 0;
  const { project: repaired, repairs } = repairProject({
    ...project,
    currentSceneId,
    timelineViewState: {
      zoomLevel: Number.isFinite(view.zoomLevel) && view.zoomLevel > 0 ? view.zoomLevel : 1,
      scrollLeft: Number.isFinite(view.scrollLeft) && view.scrollLeft >= 0 ? view.scrollLeft : 0,
      playheadTime: mediaTime(Math.max(0, playhead)),
    },
  });
  const sceneId = repaired.scenes.some((s) => s.id === repaired.currentSceneId) ? repaired.currentSceneId : (repaired.scenes.find((s) => s.isMain) ?? repaired.scenes[0])!.id;
  return { ...repaired, currentSceneId: sceneId, ...(repairs.length > 0 ? { repairNotes: repairs } : {}) };
}

/** Describes a stored row that `deserializeProject` rejected, without reading anything that could throw. */
export function describeUnreadable(id: string, json: string, error: unknown): UnreadableProject {
  let name: string | null = null;
  try {
    const parsed: unknown = JSON.parse(json);
    const metadata = isRecord(parsed) ? parsed.metadata : undefined;
    if (isRecord(metadata) && typeof metadata.name === "string") name = metadata.name;
  } catch {
    name = null;
  }
  const newer = error instanceof ProjectFormatError && error.kind === "newer-version";
  return { id, reason: newer ? "newer-version" : "damaged", detail: error instanceof Error ? error.message : "Unreadable project data", name };
}
