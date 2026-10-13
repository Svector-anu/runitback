import { batch, type Command } from "#/engine/commands";
import { PARAM, numberParam, type MediaAssetInfo, type TimelineElement } from "#/engine/model";
import type { LocatedElement } from "#/engine/timeline";
import { defineTool, ok, ToolError } from "./env";
import { paramEditCommand, paramSpecsFor } from "./params";
import type { AgentTool } from "./types";

export interface NoiseMeasurement {
  /** Estimated noise floor (dBFS) of the source audio before and after full noise removal. */
  noiseFloorBeforeDb: number;
  noiseFloorAfterDb: number;
}

/** Injected by the app: computes (once, cached) the denoised copy of an asset and measures it. Omitted in headless runs. */
export interface NoiseDeps {
  prepare(input: { assetId: string }): Promise<NoiseMeasurement>;
}

const round1 = (n: number): number => Math.round(n * 10) / 10;

function audioAssetId(located: LocatedElement, assets: ReadonlyArray<MediaAssetInfo>): string {
  const element: TimelineElement = located.element;
  if (element.type === "audio") return element.mediaId;
  if (element.type === "video") {
    if (assets.find((a) => a.id === element.mediaId)?.hasAudio === false) {
      throw new ToolError(`"${element.id}" is a video without an audio track.`, "Pick a clip that has sound.");
    }
    if (element.isSourceAudioEnabled === false) throw new ToolError(`"${element.id}" has its audio extracted to another clip.`, "Use the extracted audio clip instead.");
    return element.mediaId;
  }
  throw new ToolError(`"${element.id}" is a ${element.type} clip, which has no audio.`, "Pick a video or audio clip from get_timeline.");
}

export function createNoiseTools(deps: Partial<NoiseDeps> = {}): AgentTool[] {
  const reduceNoise = defineTool<{ elementIds: string[]; strength?: number }>({
    name: "reduce_noise",
    description:
      "Removes background noise (hiss, hum, fans, room tone) from video or audio clips with an on-device speech-aware denoiser (RNNoise). Sets the clip's `denoise` strength, 0..1 (default 1; 0 turns it off). Non-destructive: the source is untouched, preview and export both play the cleaned audio, and one undo restores the original. The first use on a file analyses it (seconds per minute of audio) and the result is cached. Tuned for speech: music and sound effects can lose detail, so lower the strength for those. Reports the estimated noise floor before and after in dBFS. One undo step for all clips.",
    inputSchema: {
      type: "object",
      properties: {
        elementIds: { type: "array", items: { type: "string" }, description: "Video or audio clip ids from get_timeline." },
        strength: { type: "number", minimum: 0, maximum: 1, description: "0 = off, 1 = full removal (default 1)." },
      },
      required: ["elementIds"],
    },
    readOnly: false,
    async run(input, env) {
      env.requireProject();
      if (input.elementIds.length === 0) throw new ToolError("elementIds is empty.", "Pass at least one video or audio clip id.");
      const strength = input.strength ?? 1;
      const targets = env.requireMany(input.elementIds);
      const assets = env.doc.assets;
      const assetIds = [...new Set(targets.map((t) => audioAssetId(t, assets)))];
      const measurements: Array<{ assetId: string } & NoiseMeasurement> = [];
      if (strength > 0 && deps.prepare) {
        for (const assetId of assetIds) {
          try {
            measurements.push({ assetId, ...(await deps.prepare({ assetId })) });
          } catch (error) {
            throw new ToolError(`Could not analyse the audio of asset "${assetId}": ${error instanceof Error ? error.message : String(error)}`, "Nothing was changed.");
          }
        }
      }
      const spec = paramSpecsFor(targets[0]?.element as TimelineElement).find((s) => s.key === PARAM.denoise);
      if (!spec) throw new ToolError("This clip type has no noise removal.");
      const commands: Command[] = targets.map((t) =>
        paramEditCommand({ element: t.element, ref: t.ref, values: { [PARAM.denoise]: strength }, playhead: env.playhead, label: "Noise removal" }).command);
      env.editor.execute(batch("Noise removal", commands));
      const worst = measurements.reduce<NoiseMeasurement | null>((acc, m) => (acc && acc.noiseFloorBeforeDb - acc.noiseFloorAfterDb >= m.noiseFloorBeforeDb - m.noiseFloorAfterDb ? acc : m), null);
      const note = worst
        ? ` Estimated noise floor ${round1(worst.noiseFloorBeforeDb)} dBFS -> ${round1(worst.noiseFloorAfterDb)} dBFS at full strength.`
        : strength > 0 ? " The audio is processed the first time it plays or exports." : "";
      return ok(
        strength > 0 ? `Noise removal ${Math.round(strength * 100)}% on ${targets.length} clip(s).${note}` : `Noise removal turned off on ${targets.length} clip(s).`,
        {
          elementIds: targets.map((t) => t.element.id), strength,
          measured: measurements.map((m) => ({ assetId: m.assetId, noiseFloorBeforeDb: round1(m.noiseFloorBeforeDb), noiseFloorAfterDb: round1(m.noiseFloorAfterDb) })),
          previous: targets.map((t) => numberParam(t.element.params, PARAM.denoise, 0)),
        },
      );
    },
  });
  return [reduceNoise];
}
