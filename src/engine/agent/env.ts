import { currentScene, type EditorDocument } from "#/engine/commands";
import type { Editor } from "#/engine/editor";
import type { ElementRef, Scene, SceneTracks, TimelineTrack } from "#/engine/model";
import { allElements, type LocatedElement } from "#/engine/timeline";
import {
  TICKS_PER_SECOND, frameDuration, mediaTimeFromSeconds, roundToFrame, type FrameRate, type MediaTime,
} from "#/engine/time";
import type { AgentTool, JsonSchema, ToolContext, ToolResult } from "./types";
import { validateInput } from "./validate";

/** Thrown inside a tool to produce a model-readable failure; never escapes `defineTool`. */
export class ToolError extends Error {
  constructor(message: string, readonly hint?: string) {
    super(message);
    this.name = "ToolError";
  }
}

export function ok(summary: string, data?: unknown): ToolResult {
  return data === undefined ? { ok: true, summary } : { ok: true, summary, data };
}

export function fail(error: string, hint?: string): ToolResult {
  return hint === undefined ? { ok: false, error } : { ok: false, error, hint };
}

/** Ticks to seconds rounded to milliseconds, the precision reported to the agent. */
export function toSec(ticks: number): number {
  return Math.round((ticks / TICKS_PER_SECOND) * 1000) / 1000;
}

const MAX_LISTED_IDS = 12;

function listIds(ids: ReadonlyArray<string>): string {
  const shown = ids.slice(0, MAX_LISTED_IDS).join(", ");
  return ids.length > MAX_LISTED_IDS ? `${shown}, ... (${ids.length} total)` : shown || "(none)";
}

/** Per-call view of the editor with the boundary conversions every tool needs. */
export class ToolEnv {
  constructor(readonly ctx: ToolContext) {}

  get editor(): Editor { return this.ctx.editor; }
  get doc(): EditorDocument { return this.editor.getState().doc; }
  get scene(): Scene { return currentScene(this.doc); }
  get tracks(): SceneTracks { return this.scene.tracks; }
  get fps(): FrameRate { return this.doc.settings.fps; }
  get playhead(): MediaTime { return this.editor.playback.getState().currentTime; }

  requireProject(): void {
    if (!this.editor.hasProject) throw new ToolError("No project is open.", "Open or create a project before using editing tools.");
  }

  /** Seconds from the agent to ticks on the project's frame grid. */
  snap(seconds: number): MediaTime {
    return roundToFrame(mediaTimeFromSeconds(seconds), this.fps);
  }

  /** Runs several editor calls as one undo step; rolls everything back if `fn` throws. */
  atomically<T>(label: string, fn: () => T): T {
    this.editor.beginTransaction(label);
    try {
      const value = fn();
      this.editor.commitTransaction();
      return value;
    } catch (error) {
      this.editor.rollbackTransaction();
      throw error;
    }
  }

  /** Ticks to the nearest frame boundary. */
  snapTicks(ticks: number): MediaTime {
    return roundToFrame(ticks, this.fps);
  }

  /** Like `snap` but never shorter than one frame. */
  snapDuration(seconds: number): MediaTime {
    const snapped = this.snap(seconds);
    const frame = frameDuration(this.fps);
    return snapped < frame ? frame : snapped;
  }

  locate(elementId: string): LocatedElement | undefined {
    return allElements(this.tracks).find((l) => l.element.id === elementId);
  }

  require(elementId: string): LocatedElement {
    const found = this.locate(elementId);
    if (found) return found;
    const known = allElements(this.tracks).map((l) => l.element.id);
    throw new ToolError(
      `No element with id "${elementId}" in the current scene.`,
      `Call get_timeline to see element ids. Existing ids: ${listIds(known)}.`,
    );
  }

  requireMany(elementIds: ReadonlyArray<string>): LocatedElement[] {
    const unique = [...new Set(elementIds)];
    return unique.map((id) => this.require(id));
  }

  requireTrack(trackId: string): TimelineTrack {
    const tracks = [...this.tracks.overlay, this.tracks.main, ...this.tracks.audio];
    const found = tracks.find((t) => t.id === trackId);
    if (found) return found;
    throw new ToolError(
      `No track with id "${trackId}".`,
      `Call get_timeline to see track ids. Existing ids: ${listIds(tracks.map((t) => t.id))}.`,
    );
  }

  refOf(located: LocatedElement): ElementRef { return located.ref; }
}

export interface ToolSpec<I> {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  readOnly: boolean;
  run(input: I, env: ToolEnv): ToolResult | Promise<ToolResult>;
}

function asFailure(error: unknown): ToolResult {
  if (error instanceof ToolError) return fail(error.message, error.hint);
  const message = error instanceof Error ? error.message : String(error);
  return fail(`The editor rejected the operation: ${message}`, "Re-read the timeline with get_timeline and retry with different arguments.");
}

/**
 * Wraps a tool body with schema validation and error translation, so a tool can never throw and never sees
 * input that violates its own schema.
 */
export function defineTool<I>(spec: ToolSpec<I>): AgentTool {
  return {
    name: spec.name,
    description: spec.description,
    inputSchema: spec.inputSchema,
    readOnly: spec.readOnly,
    async run(input: unknown, ctx: ToolContext): Promise<ToolResult> {
      const validation = validateInput(spec.inputSchema, input);
      if (!validation.ok) return fail(validation.error, validation.hint);
      try {
        return await spec.run(validation.value as I, new ToolEnv(ctx));
      } catch (error) {
        return asFailure(error);
      }
    },
  };
}

