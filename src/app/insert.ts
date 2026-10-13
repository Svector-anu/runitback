import { addClipEffect, insertElement, insertMediaElement, currentScene, type Command, type InsertPlacement } from "#/engine/commands";
import type { Editor } from "#/engine/editor";
import {
  buildDefaultEffect, buildEffectElement, buildGraphicElement, buildTextElement, orderedTracks, GRAPHIC_DEFINITIONS, getEffectDefinition,
  type MediaAssetInfo, type TimelineElement,
} from "#/engine/model";
import { mediaTime } from "#/engine/time";
import { startBackgroundAnalysis } from "./background-removal";
import { allElements, type DropTarget } from "#/engine/timeline";
import type { DragPayload } from "#/ui/dnd";

export function placementFromTarget(editor: Editor, target: DropTarget): InsertPlacement {
  if (target.isNewTrack) return { mode: "newTrack", index: target.trackIndex };
  const track = orderedTracks(currentScene(editor.getState().doc).tracks)[target.trackIndex];
  return track ? { mode: "explicit", trackId: track.id } : { mode: "auto" };
}

export function elementForPayload(editor: Editor, payload: DragPayload, startTime: number): TimelineElement | null {
  const id = editor.newId();
  const start = mediaTime(Math.max(0, startTime));
  switch (payload.kind) {
    case "text": return buildTextElement({ id, startTime: start });
    case "graphic": {
      const def = GRAPHIC_DEFINITIONS[payload.definitionId];
      return def ? buildGraphicElement({ id, startTime: start, definitionId: def.id, name: def.name }) : null;
    }
    case "effect": {
      const def = getEffectDefinition(payload.effectType);
      return def ? buildEffectElement({ id, startTime: start, effectType: def.type, params: buildDefaultEffect(def.type, "").params, name: def.name }) : null;
    }
    case "media": return null;
  }
}

export type InsertOutcome = { ok: true } | { ok: false; message: string };

const UNSUPPORTED: InsertOutcome = { ok: false, message: "That item can no longer be added." };

/**
 * Insert a dragged or clicked asset at a drop target (timeline drag) or via automatic placement (the "+" buttons).
 * The first media clip of an empty timeline ignores the drop position and starts at 0 on the main track.
 */
export function insertPayload(input: { editor: Editor; payload: DragPayload; startTime: number; target?: DropTarget | null }): InsertOutcome {
  const { editor, payload } = input;
  const placement: InsertPlacement = input.target ? placementFromTarget(editor, input.target) : { mode: "auto" };
  const run = (command: Command): InsertOutcome => {
    const result = editor.tryExecute(command);
    return result.ok ? { ok: true } : { ok: false, message: result.error.message };
  };

  if (payload.kind === "effect" && !input.target?.targetElement && getEffectDefinition(payload.effectType)?.scope === "clip") {
    return { ok: false, message: `${getEffectDefinition(payload.effectType)?.name ?? "That effect"} works on a single clip. Drop it onto a video or image clip.` };
  }
  if (payload.kind === "effect" && input.target?.targetElement) {
    const outcome = run(addClipEffect({ ref: { trackId: input.target.targetElement.trackId, elementId: input.target.targetElement.elementId }, effectType: payload.effectType }));
    if (outcome.ok && payload.effectType === "remove-background") {
      const target = allElements(currentScene(editor.getState().doc).tracks).find((l) => l.element.id === input.target?.targetElement?.elementId)?.element;
      if (target && "mediaId" in target) startBackgroundAnalysis(target.mediaId);
    }
    return outcome;
  }
  if (payload.kind === "media") {
    const asset: MediaAssetInfo | undefined = editor.getAsset(payload.assetId);
    if (!asset) return UNSUPPORTED;
    if (input.target && allElements(currentScene(editor.getState().doc).tracks).length === 0) {
      return run(insertMediaElement({ asset, elementId: editor.newId(), startTime: 0, placement: { mode: "auto" } }));
    }
    return run(insertMediaElement({ asset, elementId: editor.newId(), startTime: input.startTime, placement }));
  }
  const element = elementForPayload(editor, payload, input.startTime);
  if (!element) return UNSUPPORTED;
  return run(insertElement({ element, placement }));
}
