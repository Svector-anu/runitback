import { addClipEffect, batch, removeClipEffect, toggleClipEffect, updateClipEffectParams, type Command } from "#/engine/commands";
import type { Effect, TimelineElement } from "#/engine/model";
import { defineTool, ok, ToolError } from "./env";
import { effectSpecs, specList, validateParamValues } from "./params";
import type { AgentTool } from "./types";

/** Injected by the app layer: whether masks exist for an asset, and how to produce them on-device. */
export interface BackgroundDeps {
  isReady(assetId: string): Promise<boolean>;
  /** Segments the whole asset and stores the masks; resolves when the preview/export can use them. Rejects with an Error on failure or abort. */
  analyze(input: { assetId: string }): Promise<{ frames: number; personShare: number }>;
}

type Decorated = TimelineElement & { effects?: Effect[] };
const SPECS = effectSpecs("remove-background");

const effectOf = (element: TimelineElement): Effect | undefined => (element as Decorated).effects?.find((e) => e.type === "remove-background");

export function createBackgroundTools(deps: BackgroundDeps): AgentTool[] {
  const removeBackground = defineTool<{ elementIds: string[]; softness?: number; invert?: boolean; remove?: boolean }>({
    name: "remove_background",
    description:
      `Cut the person out of video or image clips so the layers below show through (virtual background). Runs an on-device person-segmentation model (MediaPipe Selfie Segmenter, no upload): the first use on a media file analyses it, which takes a while (roughly real time on a laptop; the result is saved, so later calls are instant). One remove-background effect per clip (created on first use, edited afterwards). Put the clip on an overlay track above the footage it should reveal. Parameters: ${specList(SPECS)}. softness (0-100, default 40) widens the soft edge; invert keeps the background and removes the person. Quality: edges can flicker on fast motion or hair, and several people are all kept; it segments people only, not arbitrary objects. \`remove: true\` deletes the effect. One undo step.`,
    inputSchema: {
      type: "object",
      properties: {
        elementIds: { type: "array", items: { type: "string" }, description: "Video or image clip ids from get_timeline." },
        softness: { type: "number", minimum: 0, maximum: 100 },
        invert: { type: "boolean" },
        remove: { type: "boolean", description: "Remove the effect from these clips." },
      },
      required: ["elementIds"],
    },
    readOnly: false,
    async run(input, env) {
      env.requireProject();
      if (input.elementIds.length === 0) throw new ToolError("elementIds is empty.", "Pass at least one clip id.");
      const targets = env.requireMany(input.elementIds);
      for (const t of targets) {
        if (t.element.type !== "video" && t.element.type !== "image") throw new ToolError(`Background removal applies to video and image clips, not ${t.element.type}.`, "Pick a video or image clip from get_timeline.");
      }
      if (input.remove === true) {
        const commands = targets.flatMap((t) => { const e = effectOf(t.element); return e ? [removeClipEffect(t.ref, e.id)] : []; });
        if (commands.length === 0) throw new ToolError("None of those clips has background removal.", "Nothing to remove.");
        env.editor.execute(batch("Remove background removal", commands));
        return ok(`Removed background removal from ${commands.length} clip(s).`, { elementIds: input.elementIds });
      }
      const raw: Record<string, unknown> = {};
      if (input.softness !== undefined) raw.softness = input.softness;
      if (input.invert !== undefined) raw.invert = input.invert;
      const params = Object.keys(raw).length > 0 ? validateParamValues({ specs: SPECS, values: raw, subject: "remove-background effect" }) : {};

      const assetIds = [...new Set(targets.flatMap((t) => (t.element.type === "video" || t.element.type === "image" ? [t.element.mediaId] : [])))];
      const analysed: Array<{ assetId: string; frames: number; personShare: number }> = [];
      for (const assetId of assetIds) {
        if (await deps.isReady(assetId)) continue;
        try {
          analysed.push({ assetId, ...(await deps.analyze({ assetId })) });
        } catch (error) {
          throw new ToolError(`Could not analyse "${assetId}": ${error instanceof Error ? error.message : String(error)}`, "Retry once; if it keeps failing, tell the user background removal is unavailable here.");
        }
      }

      const commands: Command[] = targets.flatMap((t) => {
        const existing = effectOf(t.element);
        if (existing) {
          return [
            ...(Object.keys(params).length > 0 ? [updateClipEffectParams(t.ref, existing.id, params)] : []),
            ...(existing.enabled ? [] : [toggleClipEffect(t.ref, existing.id)]),
          ];
        }
        const effectId = env.editor.newId();
        return [addClipEffect({ ref: t.ref, effectType: "remove-background", effectId }), ...(Object.keys(params).length > 0 ? [updateClipEffectParams(t.ref, effectId, params)] : [])];
      });
      if (commands.length > 0) env.editor.execute(batch("Remove background", commands));
      const lowPresence = analysed.filter((a) => a.personShare < 0.05).map((a) => a.assetId);
      const warning = lowPresence.length > 0 ? ` No person was found in ${lowPresence.join(", ")}: the clip will turn (almost) fully transparent.` : "";
      return ok(`Background removal set on ${targets.length} clip(s)${analysed.length > 0 ? `; analysed ${analysed.length} media file(s)` : ""}.${warning}`, {
        elementIds: targets.map((t) => t.element.id), analysed,
      });
    },
  });
  return [removeBackground];
}
