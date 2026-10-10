import type { MediaAssetInfo } from "#/engine/model";
import {
  STAGE_LABELS, describeStatus, understandStatus, type StoredStages, type UnderstandRunSummary, type UnderstandStartResult, type UnderstandStatus,
} from "#/engine/understand";
import { defineTool, ok, ToolError, type ToolEnv } from "./env";
import type { AgentTool } from "./types";

/** Reads what is stored for an asset, across the analysis cache and the transcript, visual and face stores. */
export interface UnderstandStatusProvider {
  stored(asset: MediaAssetInfo): Promise<StoredStages>;
}

export interface UnderstandDeps {
  status: UnderstandStatusProvider;
  /** Starts the same pipeline as the Understand button, through the same consent gate. Omit for a read-only agent. */
  start?: (assetId: string) => Promise<UnderstandStartResult>;
}

const ASSET_ID = { type: "string", description: "Asset id from list_assets." } as const;

async function statusOf(deps: UnderstandDeps, asset: MediaAssetInfo): Promise<UnderstandStatus> {
  return understandStatus({ asset, stored: await deps.status.stored(asset) });
}

const view = (status: UnderstandStatus): Record<string, unknown> => ({
  assetId: status.assetId, state: status.state, summary: describeStatus(status), indexed: status.indexed, missing: status.missing,
  notApplicable: Object.entries(status.stages).filter(([, v]) => v === "not-applicable").map(([k]) => k),
});

function requireAsset(env: ToolEnv, assetId: string): MediaAssetInfo {
  const asset = env.editor.getAsset(assetId);
  if (!asset) throw new ToolError(`No asset with id "${assetId}".`, `Call list_assets. Known ids: ${env.doc.assets.map((a) => a.id).join(", ") || "(none)"}.`);
  return asset;
}

const summaryLine = (run: UnderstandRunSummary): string => {
  const failed = Object.entries(run.errors).map(([stage, message]) => `${STAGE_LABELS[stage as keyof typeof STAGE_LABELS].toLowerCase()}: ${message}`);
  return failed.length > 0 ? `Some stages failed (${failed.join("; ")}).` : "";
};

export function createUnderstandTools(deps: UnderstandDeps): AgentTool[] {
  const getStatus = defineTool<{ assetId?: string }>({
    name: "get_understanding_status",
    description:
      "What is already indexed for footage: per asset, which of analysis (silence, loudness, cuts), transcript, visual index and faces exist and which are missing. Omit assetId for every asset. Use it before relying on find_visual_moments, get_transcript or face data. Read-only.",
    inputSchema: { type: "object", properties: { assetId: ASSET_ID } },
    readOnly: true,
    async run(input, env) {
      env.requireProject();
      const assets = input.assetId === undefined ? env.doc.assets : [requireAsset(env, input.assetId)];
      const statuses = await Promise.all(assets.map((asset) => statusOf(deps, asset)));
      const understood = statuses.filter((s) => s.state === "understood").length;
      return ok(`${understood} of ${statuses.length} asset(s) fully understood.`, { assets: statuses.map(view) });
    },
  });

  const start = deps.start;
  if (!start) return [getStatus];

  const understand = defineTool<{ assetId: string; wait?: boolean }>({
    name: "understand_media",
    description:
      "Run the full Understand pipeline on an asset: analysis, transcript (if it has audio), visual index and faces. Stages that are already stored are skipped. Slow for long media; the first run downloads models and needs the user's approval. A failing stage does not stop the others. Does not change the project.",
    inputSchema: {
      type: "object",
      properties: { assetId: ASSET_ID, wait: { type: "boolean", description: "Wait for the run to finish (default true). With false it returns as soon as the run starts; poll get_understanding_status." } },
      required: ["assetId"],
    },
    readOnly: true,
    async run(input, env) {
      env.requireProject();
      const asset = requireAsset(env, input.assetId);
      if (asset.type === "image") throw new ToolError(`Asset "${input.assetId}" is an image; there is nothing to analyse.`, "Pass a video or audio asset.");
      const started = await start(input.assetId);
      if (started.status === "needs-consent") {
        const what = started.downloads.map((d) => `${d.model} (about ${d.approxMegabytes} MB)`).join(", ");
        throw new ToolError(
          `Understanding needs one-time model downloads the user has not approved: ${what}. Ask the user to press Understand on this asset in the Assets panel, then retry.`,
          "Do not retry until the user confirms the download; then call understand_media again.",
        );
      }
      if (started.status === "nothing-to-do") return ok("Already understood; nothing to do.", view(await statusOf(deps, asset)));
      if (input.wait === false) return ok("Understanding started. Poll get_understanding_status for progress.", { assetId: input.assetId, started: true });
      const run = await started.completion;
      const status = await statusOf(deps, asset);
      const note = run.cancelled ? "The run was cancelled by the user." : summaryLine(run);
      return ok(`${describeStatus(status)}.${note ? ` ${note}` : ""}`, { ...view(status), outcomes: run.outcomes, errors: run.errors, cancelled: run.cancelled });
    },
  });
  return [getStatus, understand];
}
