import { defineTool, fail, ok, ToolError } from "./env";
import type { AgentTool } from "./types";

export type GenerateMediaKind = "image" | "video" | "music" | "speech";

export const GENERATE_MEDIA_KINDS: ReadonlyArray<GenerateMediaKind> = ["image", "video", "music", "speech"];
/** A run may spend the user's credits this many times; the user can ask again for more. */
export const MAX_GENERATIONS_PER_RUN = 3;

export interface GeneratePlan {
  modelId: string;
  modelName: string;
  /** Human-readable cost, e.g. "About $0.04" or "Price not listed in the catalog". */
  costText: string;
  /** Set when the call must not run without the user pressing Generate themselves; the reason is written for the model. */
  refusal?: string;
}

export interface GeneratedAssetInfo {
  assetId: string;
  name: string;
  type: "image" | "video" | "audio";
  durationSeconds?: number;
  chargeText: string;
}

export interface GenerateDeps {
  /** Resolves the model and its estimated cost without spending anything. */
  prepare(input: { kind: GenerateMediaKind; prompt: string; model?: string }): GeneratePlan | { error: string; hint?: string };
  /** Generates and imports. Rejects with a model-readable message on failure. */
  generate(input: { kind: GenerateMediaKind; prompt: string; model?: string }): Promise<GeneratedAssetInfo>;
}

/**
 * `generate_media` spends the user's own Surplus credits and sends the prompt to a third party, so it is `destructive`
 * (never allowed without an approved plan, and refused outside the plan's step tools), is capped per run, and refuses a
 * call whose estimated price is above the agent allowance. The tool exists only while a Surplus key is saved.
 */
export function createGenerateTools(deps: GenerateDeps): AgentTool[] {
  let used = 0;
  const generateMedia = defineTool<{ kind: GenerateMediaKind; prompt: string; model?: string }>({
    name: "generate_media",
    description:
      "Generate an image, video clip, music track or voice-over from a text prompt with the user's own Surplus credits and add it to the media library (not the timeline; place it with insert_media). COSTS REAL MONEY and sends the prompt to Surplus Intelligence, so list it in the plan with its estimated cost, call it only when the user asked for generated media, and never to retry a result you merely dislike. Video and music take minutes. For speech the prompt is the exact text to be spoken. Returns the new asset id.",
    inputSchema: {
      type: "object",
      properties: {
        kind: { type: "string", enum: [...GENERATE_MEDIA_KINDS], description: "image, video, music or speech." },
        prompt: { type: "string", description: "What to generate (for speech: the exact words to speak). Up to 2000 characters." },
        model: { type: "string", description: "Surplus model id. Omit for the user's selected model, or the cheapest one." },
      },
      required: ["kind", "prompt"],
      additionalProperties: false,
    },
    readOnly: false,
    destructive: true,
    async run(input, env) {
      env.requireProject();
      if (used >= MAX_GENERATIONS_PER_RUN) {
        throw new ToolError(`Already generated ${MAX_GENERATIONS_PER_RUN} files in this request.`, "Each generation costs the user money. Tell the user what you generated and ask before generating more.");
      }
      const plan = deps.prepare(input);
      if ("error" in plan) throw new ToolError(plan.error, plan.hint);
      if (plan.refusal) throw new ToolError(plan.refusal, "Ask the user to press Generate in the Generate tab for this one, or pick a cheaper model.");
      used++;
      let made: GeneratedAssetInfo;
      try {
        made = await deps.generate(input);
      } catch (error) {
        used--;
        return fail(error instanceof Error ? error.message : String(error), "Nothing was added. Do not retry automatically; report the failure to the user.");
      }
      const length = made.durationSeconds === undefined ? "" : `, ${Math.round(made.durationSeconds * 10) / 10}s`;
      return ok(
        `Generated ${input.kind} "${made.name}" with ${plan.modelName} and added it to the media library as asset ${made.assetId}${length}. ${made.chargeText} Use insert_media to place it.`,
        { assetId: made.assetId, name: made.name, type: made.type, model: plan.modelId, ...(made.durationSeconds !== undefined ? { durationSeconds: made.durationSeconds } : {}) },
      );
    },
  });
  return [generateMedia];
}
