import {
  addClipEffect, autoZoomCommand, batch, deleteElements, insertElement, setCursorPathCommand, setTextAnimationCommand, setTransitionCommand,
  updateClipEffectParams, updateElements, updateSettings, upsertKeyframeCommand, type Command, type InsertPlacement,
} from "#/engine/commands";
import type { Editor } from "#/engine/editor";
import {
  FILTER_PRESETS, GRAPHIC_DEFINITIONS, IMAGE_DEFAULTS, MASK_DEFINITIONS, buildGraphicElement, buildMediaElement, buildTextElement, defaultsOf, orderedTracks,
  PARAM, type ElementRef, type ImageElement, type MediaAssetInfo, type ParamValues, type TextAnimationSpec, type TimelineElement, type VideoElement,
} from "#/engine/model";
import { inferCount } from "#/engine/render";
import { allElements, canPlaceSpans, elementEnd, highestInsertIndex, maxTransitionDuration, trackTypeForElement, transitionPartner } from "#/engine/timeline";
import { TICKS_PER_SECOND, frameRateToFloat, mediaTime, type MediaTime } from "#/engine/time";
import { planTemplate, type PlannedClip, type TemplateInputs, type TemplatePlan, type TemplateWarning } from "./apply";
import type { ProjectTemplate } from "./types";

export type TemplateApplyErrorCode = "no-project" | "timeline-not-empty" | "missing-slots";

/** Thrown before anything is changed; the message and hint are written for a person or a model to act on. */
export class TemplateApplyError extends Error {
  constructor(readonly code: TemplateApplyErrorCode, message: string, readonly hint: string) {
    super(message);
    this.name = "TemplateApplyError";
  }
}

export interface ApplyTemplateOptions {
  /** Clear the current scene's clips first (still one undo step). Without it a non-empty timeline is refused. */
  replace?: boolean;
  /** Refuse (changing nothing) when a required slot has no usable media, instead of leaving that part empty with a warning. */
  requireAllSlots?: boolean;
  /** Undo label. */
  label?: string;
}

export interface ApplyTemplateResult {
  templateId: string;
  elementIds: string[];
  warnings: TemplateWarning[];
  missingSlots: string[];
  durationSeconds: number;
  canvas: { width: number; height: number };
  fps: number;
}

const secondsOf = (ticks: number): number => Math.round((ticks / TICKS_PER_SECOND) * 1000) / 1000;

function buildElement(clip: PlannedClip, id: string, assets: ReadonlyMap<string, MediaAssetInfo>): TimelineElement {
  switch (clip.type) {
    case "text": {
      const base = buildTextElement({ id, startTime: clip.start, name: clip.name, duration: clip.duration });
      return { ...base, params: { ...base.params, ...clip.params } };
    }
    case "graphic": {
      const definition = GRAPHIC_DEFINITIONS[clip.shape];
      const base = buildGraphicElement({
        id, startTime: clip.start, definitionId: clip.shape, name: clip.name, params: { ...defaultsOf(definition?.params ?? []), ...clip.params },
      });
      return { ...base, duration: clip.duration };
    }
    case "audio":
    case "video":
    case "image": {
      const asset = assets.get(clip.assetId);
      if (!asset) throw new Error(`Planned asset ${clip.assetId} disappeared`);
      if (clip.type === "image" && clip.freezeAt !== undefined) {
        const held: ImageElement = {
          id, type: "image", name: clip.name, mediaId: asset.id, freezeAt: clip.freezeAt, startTime: clip.start, duration: clip.duration,
          trimStart: mediaTime(0), trimEnd: mediaTime(0), params: { ...IMAGE_DEFAULTS, ...clip.params }, hidden: false,
        };
        return held;
      }
      const base = buildMediaElement({ id, startTime: clip.start, asset, name: clip.name });
      const timing = { startTime: clip.start, duration: clip.duration, trimStart: clip.trimStart, trimEnd: clip.trimEnd };
      if (base.type === "video") {
        const video: VideoElement = {
          ...base, ...timing, ...(clip.sourceDuration !== undefined ? { sourceDuration: clip.sourceDuration } : {}),
          isSourceAudioEnabled: asset.hasAudio !== false && !clip.muteSource, params: { ...base.params, ...clip.params },
        };
        return video;
      }
      if (base.type === "audio") return { ...base, ...timing, ...(clip.sourceDuration !== undefined ? { sourceDuration: clip.sourceDuration } : {}) };
      return { ...base, ...timing, params: { ...base.params, ...clip.params } };
    }
  }
}

function placementFor(editor: Editor, element: TimelineElement, clip: PlannedClip): InsertPlacement {
  const { tracks } = currentTracks(editor);
  const span = [{ start: element.startTime, duration: element.duration }];
  if (clip.type === "text" || clip.type === "graphic" || clip.type === "audio") return { mode: "auto" };
  if (clip.placement === "main" && canPlaceSpans(tracks.main, span)) return { mode: "explicit", trackId: tracks.main.id };
  const lane = tracks.overlay.find((t) => t.type === "video" && canPlaceSpans(t, span));
  if (lane) return { mode: "explicit", trackId: lane.id };
  return { mode: "newTrack", index: highestInsertIndex(tracks, trackTypeForElement(element.type)) };
}

function currentTracks(editor: Editor) {
  const { doc } = editor.getState();
  const scene = doc.scenes.find((s) => s.id === doc.currentSceneId);
  if (!scene) throw new Error("The current scene is missing");
  return scene;
}

function locate(editor: Editor, elementId: string): { ref: ElementRef; element: TimelineElement; siblings: ReadonlyArray<TimelineElement> } | undefined {
  const found = allElements(currentTracks(editor).tracks).find((l) => l.element.id === elementId);
  if (!found) return undefined;
  const track = orderedTracks(currentTracks(editor).tracks).find((t) => t.id === found.track.id);
  return { ref: found.ref, element: found.element, siblings: (track?.elements ?? []) as TimelineElement[] };
}

function filterParams(preset: keyof typeof FILTER_PRESETS, intensity: number): ParamValues {
  const out: ParamValues = {};
  for (const [key, value] of Object.entries(FILTER_PRESETS[preset].params)) out[key] = Math.round(value * intensity);
  return out;
}

function finishClip(editor: Editor, clip: PlannedClip, elementId: string, warnings: TemplateWarning[]): void {
  const located = locate(editor, elementId);
  if (!located) return;
  const { ref } = located;
  if (clip.type === "text") {
    if (clip.animation) {
      const countable = inferCount(String(located.element.params[PARAM.content] ?? "")) !== null || located.element.params[PARAM.countEnabled] === true;
      const keep = (spec: TextAnimationSpec | undefined, side: "in" | "out"): TextAnimationSpec | undefined => {
        if (spec?.preset !== "count-up" || countable) return spec;
        warnings.push({ code: "count-skipped", message: `The count-up ${side} animation on "${clip.name}" was skipped: its text has no number to count to.` });
        return undefined;
      };
      const incoming = keep(clip.animation.in, "in");
      const outgoing = keep(clip.animation.out, "out");
      if (incoming || outgoing) editor.execute(setTextAnimationCommand({ ref, ...(incoming ? { in: incoming } : {}), ...(outgoing ? { out: outgoing } : {}) }));
    }
    return;
  }
  if (clip.type === "graphic") {
    if (clip.cursorPath) editor.execute(setCursorPathCommand({ ref, waypoints: clip.cursorPath }));
    return;
  }
  const commands: Command[] = [];
  if (clip.filter && clip.type !== "audio") {
    const effectId = editor.newId();
    commands.push(addClipEffect({ ref, effectType: "adjust", effectId }), updateClipEffectParams(ref, effectId, filterParams(clip.filter.preset, clip.filter.intensity)));
  }
  if (clip.shadow && clip.type !== "audio") {
    const effectId = editor.newId();
    commands.push(addClipEffect({ ref, effectType: "shadow", effectId }), updateClipEffectParams(ref, effectId, clip.shadow));
  }
  if (clip.corners !== undefined && clip.type !== "audio") {
    const mask = { id: editor.newId(), type: "rectangle" as const, params: { ...defaultsOf(MASK_DEFINITIONS.rectangle.params), width: 1, height: 1, cornerRadius: clip.corners } };
    commands.push(updateElements([{ ref, patch: { masks: [mask] } }], "Template corners"));
  }
  for (const key of clip.keyframes) commands.push(upsertKeyframeCommand({ ref, path: key.path, time: key.time, value: key.value }));
  if (clip.autoZooms && clip.type !== "audio") commands.push(autoZoomCommand({ ref, zooms: clip.autoZooms }));
  if (commands.length > 0) editor.execute(batch("Template look", commands));
  if (clip.transition) {
    const partner = transitionPartner(located.siblings, located.element);
    if (!partner) return;
    const duration = Math.min(clip.transition.duration, maxTransitionDuration(partner, located.element));
    if (duration >= 1) editor.execute(setTransitionCommand({ ref, transition: { type: clip.transition.type, duration } }));
    else warnings.push({ code: "transition-skipped", message: `The ${clip.transition.type} transition into "${clip.name}" was skipped: the clips are too short.` });
  }
}

/** Runs a plan against the editor inside the caller's transaction. Returns the ids of the clips it created, in plan order. */
function runPlan(editor: Editor, plan: TemplatePlan, warnings: TemplateWarning[]): string[] {
  const assets = new Map(editor.getState().doc.assets.map((a) => [a.id, a]));
  const created: Array<{ clip: PlannedClip; id: string }> = [];
  for (const clip of plan.clips) {
    const id = editor.newId();
    const element = buildElement(clip, id, assets);
    editor.execute(insertElement({ element, placement: placementFor(editor, element, clip) }));
    created.push({ clip, id });
  }
  editor.execute(updateSettings({
    canvasSize: { ...plan.canvas }, canvasSizeMode: "preset", fps: plan.fps,
    ...(plan.gradient ? { background: plan.gradient } : plan.backgroundColor ? { background: { type: "color" as const, color: plan.backgroundColor } } : {}),
  }));
  for (const { clip, id } of created) finishClip(editor, clip, id, warnings);
  return created.map((c) => c.id);
}

/**
 * Builds the template's timeline in the open project as ONE undo step: clips, trims, text styles and animations,
 * filters, transitions, canvas and frame rate. Refuses before changing anything when no project is open, when the
 * timeline already has clips (unless `replace`), or when `requireAllSlots` is set and a required slot is unfilled.
 */
export function applyTemplateToEditor(
  editor: Editor, template: ProjectTemplate, inputs: TemplateInputs = {}, options: ApplyTemplateOptions = {},
): ApplyTemplateResult {
  if (!editor.hasProject) throw new TemplateApplyError("no-project", "No project is open.", "Open or create a project before applying a template.");
  const doc = editor.getState().doc;
  const existing = allElements(currentTracks(editor).tracks);
  if (existing.length > 0 && !options.replace) {
    throw new TemplateApplyError(
      "timeline-not-empty", `The timeline already has ${existing.length} clip(s).`,
      "Apply the template to an empty project, or pass replace:true to clear the timeline first (undoable).",
    );
  }
  const plan = planTemplate({ template, inputs, assets: doc.assets });
  if (options.requireAllSlots && plan.missingSlots.length > 0) {
    throw new TemplateApplyError(
      "missing-slots", `Required media is missing for: ${plan.missingSlots.join(", ")}.`,
      "Map every required slot to an asset id (describe_template lists the slots), or mark nothing as required by choosing a different template.",
    );
  }
  const warnings = [...plan.warnings];
  editor.beginTransaction(options.label ?? `Template: ${template.name}`);
  let elementIds: string[];
  try {
    if (existing.length > 0) editor.execute(deleteElements(existing.map((l) => l.ref)));
    elementIds = runPlan(editor, plan, warnings);
    editor.commitTransaction();
  } catch (error) {
    editor.rollbackTransaction();
    throw error;
  }
  const end: MediaTime = plan.endTime;
  const placedEnd = allElements(currentTracks(editor).tracks).reduce((m, l) => Math.max(m, elementEnd(l.element)), 0);
  return {
    templateId: template.id, elementIds, warnings, missingSlots: plan.missingSlots,
    durationSeconds: secondsOf(Math.max(end, placedEnd)), canvas: plan.canvas, fps: Math.round(frameRateToFloat(plan.fps) * 1000) / 1000,
  };
}
