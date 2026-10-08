import { addClipEffect, insertElement, insertMediaElement, currentScene, type InsertPlacement } from "#/engine/commands";
import type { Editor } from "#/engine/editor";
import {
  buildDefaultEffect, buildEffectElement, buildGraphicElement, buildTextElement, orderedTracks, GRAPHIC_DEFINITIONS, getEffectDefinition,
  type MediaAssetInfo, type TimelineElement,
} from "#/engine/model";
import { mediaTime } from "#/engine/time";
import type { DropTarget } from "#/engine/timeline";
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

/** Insert a dragged or clicked asset at a drop target (timeline drag) or via automatic placement (the "+" buttons). */
export function insertPayload(input: { editor: Editor; payload: DragPayload; startTime: number; target?: DropTarget | null }): boolean {
  const { editor, payload } = input;
  const placement: InsertPlacement = input.target ? placementFromTarget(editor, input.target) : { mode: "auto" };

  if (payload.kind === "effect" && input.target?.targetElement) {
    editor.execute(addClipEffect({ ref: { trackId: input.target.targetElement.trackId, elementId: input.target.targetElement.elementId }, effectType: payload.effectType }));
    return true;
  }
  if (payload.kind === "media") {
    const asset: MediaAssetInfo | undefined = editor.getAsset(payload.assetId);
    if (!asset) return false;
    editor.execute(insertMediaElement({ asset, elementId: editor.newId(), startTime: input.startTime, placement }));
    return true;
  }
  const element = elementForPayload(editor, payload, input.startTime);
  if (!element) return false;
  editor.execute(insertElement({ element, placement }));
  return true;
}
